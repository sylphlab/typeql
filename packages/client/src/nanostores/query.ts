import { map, onMount, task, type ReadableAtom, type Atom } from 'nanostores';
import type { Patch } from 'immer'; // Immer patches for optimistic updates
import { type Operation as PatchOperation } from 'fast-json-patch'; // JSON Patch for deltas

import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches } from './patchUtils'; // Use Immer utils
import { applyJsonDelta } from './stateUtils'; // Use JSON Patch delta applicator

// Define the shape of the state managed by the query map atom
export interface QueryMapState<TData = unknown, TError = Error> {
  data: TData | undefined;
  loading: boolean;
  error: TError | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  // Add other relevant state like lastUpdated, etc. if needed
}

// Define options for the query helper
export interface QueryOptions<TInput = unknown, TData = unknown> {
  initialData?: TData;
  enabled?: boolean; // Default: true
  // Add other options like staleTime, cacheTime, refetchOnMount, etc. later
  input: TInput;
  // TODO: Define how procedure path is passed - likely via selector function
  path: string | string[]; // Or use a selector function approach
}

// Type for the selector function to get the client instance
type ClientGetter = <T extends ZenQueryClient>(clientAtom: Atom<T>) => T;

// Type for the returned atom, including potential actions
// Use ReadableAtom<QueryMapState> as the base
export interface QueryAtom<TData = unknown, TError = Error> extends ReadableAtom<QueryMapState<TData, TError>> {
  key: AtomKey;
  reload: () => Promise<void>; // Add reload function
}

/**
 * Creates a Nanostore map atom to manage the state of a ZenQuery query.
 *
 * @param clientAtom The Nanostore atom holding the ZenQueryClient instance.
 * @param clientGetter A function to extract the client instance from the atom.
 * @param options Query configuration options including input and path/selector.
 * @returns A readable Nanostore map atom representing the query state with a reload method.
 */
export function query<
  TClient extends ZenQueryClient,
  TInput = unknown,
  // Constrain TOutput to object or array for Immer compatibility
  TOutput extends object | unknown[] = any,
  TError = Error,
>(
  clientAtom: Atom<TClient>,
  clientGetter: ClientGetter,
  options: QueryOptions<TInput, TOutput>
): QueryAtom<TOutput, TError> {

  const { initialData, enabled = true, input, path } = options;
  const client = clientGetter(clientAtom); // Get client instance
  const coordinator = client.getCoordinator(); // Assuming client exposes coordinator

  const atomKey = generateAtomKey(path, input);

  // Use a map atom to hold the query state
  const queryMapAtom = map<QueryMapState<TOutput, TError>>({
    data: initialData,
    loading: enabled, // Start loading if enabled
    error: null,
    status: enabled ? 'loading' : 'idle',
  });

  // --- Internal State ---
  let isMounted = false;
  // Store the last known confirmed state from the server
  let confirmedServerData: TOutput | undefined = initialData;
  let unsubscribeCoordinator: (() => void) | null = null;
  // Store the AbortController for the current fetch
  let currentAbortController: AbortController | null = null;

  // --- Logic Functions ---

  const computeOptimisticState = () => {
    if (!isMounted) return;

    const currentMapState = queryMapAtom.get();
    const pendingPatchesMap = coordinator.getPendingPatches(); // Map<AtomKey, Patch[]> (Immer patches)
    const patchesForThisAtom = pendingPatchesMap.get(atomKey) || [];

    let optimisticData: TOutput | undefined;
    let computationError: Error | null = null;

    if (patchesForThisAtom.length === 0) {
      optimisticData = confirmedServerData; // Use the stored confirmed state
    } else {
      try {
        // Apply Immer patches to the confirmed server state
        const baseState = confirmedServerData ?? ({} as TOutput); // Provide default if undefined
        // Cast baseState to 'any' to satisfy Immer's applyPatches if constraint isn't enough
        optimisticData = applyImmerPatches(baseState as any, patchesForThisAtom);
      } catch (error) {
        console.error(`[zenQuery][${atomKey}] Failed to apply optimistic patches:`, error);
        computationError = error instanceof Error ? error : new Error('Failed to compute optimistic state');
        optimisticData = confirmedServerData; // Fallback to confirmed state
      }
    }

    // Update the 'data' field in the map atom
    if (currentMapState.data !== optimisticData || currentMapState.error !== computationError) {
        queryMapAtom.setKey('data', optimisticData);
        if (computationError && !currentMapState.error) {
            queryMapAtom.setKey('error', computationError as TError);
            queryMapAtom.setKey('status', 'error');
        } else if (!computationError && currentMapState.error) {
            // Clear error if computation succeeded and there was a previous computation error
            queryMapAtom.setKey('error', null);
            // Don't reset status here, let fetch/delta handlers manage success/loading status
        }
    }
  };

  // Apply JSON patches received from the server delta via coordinator
  const applyServerDelta = (deltaPatches: readonly PatchOperation[]) => {
    if (!isMounted) return;
    try {
      // Use applyJsonDelta utility
      const newState = applyJsonDelta(confirmedServerData, deltaPatches);
      confirmedServerData = newState; // Update confirmed state
      // Recompute optimistic state as confirmed state changed
      computeOptimisticState();
    } catch (error) {
      console.error(`[zenQuery][${atomKey}] Failed to apply server delta:`, error);
      queryMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Failed to apply server delta') as TError);
      queryMapAtom.setKey('status', 'error');
    }
  };

  // Define the core async function for fetching data
  const fetcher = async () => {
    // Cancel previous fetch if running
    if (currentAbortController) {
        currentAbortController.abort();
        console.log(`[zenQuery][${atomKey}] Aborted previous fetch.`);
    }
    const abortController = new AbortController();
    currentAbortController = abortController;
    const signal = abortController.signal;

    // Don't fetch if not enabled
    if (!isMounted || !enabled) {
        queryMapAtom.setKey('loading', false);
        queryMapAtom.setKey('status', 'idle');
        currentAbortController = null; // Clear controller if not fetching
        return;
    };

    try {
      const normalizedPath = Array.isArray(path) ? path.join('.') : path;
      const procedure = (client.query as any)[normalizedPath];
      if (typeof procedure?.query !== 'function') {
          throw new Error(`[zenQuery] Procedure 'query.${normalizedPath}' not found or is not a query function.`);
      }

      // Check for abortion *before* the async call
      if (signal.aborted) {
          console.log(`[zenQuery][${atomKey}] Fetch aborted before start.`);
          // No need to reset state here as it was just set to loading
          return;
      }

      const result = await procedure.query(input, { signal });

      // Check for abortion *after* the async call completes but before updating state
      // Only proceed if this controller is still the current one
      if (signal.aborted || currentAbortController !== abortController) {
          console.log(`[zenQuery][${atomKey}] Fetch aborted or superseded after completion.`);
          return;
      }

      confirmedServerData = result as TOutput; // Update confirmed state
      queryMapAtom.setKey('loading', false);
      queryMapAtom.setKey('status', 'success');
      // Recompute optimistic state after fetch completes successfully
      computeOptimisticState();

    } catch (error: any) {
        // Check if the error is due to abortion and if it's the current controller
        if ((signal.aborted || error.name === 'AbortError') && currentAbortController === abortController) {
            console.log(`[zenQuery][${atomKey}] Fetch explicitly aborted.`);
            // Only reset state if this was the active fetch causing the loading state
            if (queryMapAtom.get().loading) {
                queryMapAtom.setKey('loading', false);
                queryMapAtom.setKey('status', queryMapAtom.get().data !== undefined ? 'success' : 'idle');
            }
            return; // Don't update state further
        } else if (currentAbortController !== abortController) {
            // Error is from a stale fetch, ignore it
            console.log(`[zenQuery][${atomKey}] Ignored error from stale fetch.`);
            return;
        }

      // Handle actual fetch errors
      console.error(`[zenQuery][${atomKey}] Fetch failed:`, error);
      queryMapAtom.setKey('loading', false);
      queryMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Query failed') as TError);
      queryMapAtom.setKey('status', 'error');
      // Update optimistic state even on error (it will fallback to confirmedServerData)
      computeOptimisticState();
    } finally {
        // Clear the controller instance only if it's the current one
        if (currentAbortController === abortController) {
            currentAbortController = null;
        }
    }
  };

  // Wrap the fetcher with task() to prevent concurrent executions
  // We call fetcher() directly, task() is just for the lock mechanism
  const fetchData = task(fetcher);

  // --- Lifecycle ---
  onMount(queryMapAtom, () => {
    isMounted = true;
    registerAtom(atomKey, queryMapAtom); // Register the main map atom

    const unsubChange = coordinator.onStateChange(computeOptimisticState);
    const unsubDelta = coordinator.onApplyDelta((delta: ServerDelta) => {
      if (delta.key === atomKey) {
        applyServerDelta(delta.patches); // Pass JSON patches
      }
    });

    unsubscribeCoordinator = () => {
      unsubChange();
      unsubDelta();
    };

    if (enabled) {
        const currentData = queryMapAtom.get().data;
        if (currentData !== undefined) {
            // SWR: Has stale data, set loading and revalidate in background
            queryMapAtom.setKey('loading', true);
            queryMapAtom.setKey('status', 'loading'); // Keep stale data
            fetcher(); // Revalidate
        } else {
            // No initial data, set loading and fetch
            queryMapAtom.setKey('loading', true);
            queryMapAtom.setKey('error', null); // Clear any previous error
            queryMapAtom.setKey('status', 'loading');
            fetcher(); // Initial fetch
        }
    } else {
        queryMapAtom.setKey('status', 'idle');
        queryMapAtom.setKey('loading', false);
    }

    return () => { // Cleanup function
      isMounted = false;
      // Abort ongoing fetch on unmount using the stored controller
      if (currentAbortController) {
          currentAbortController.abort();
          currentAbortController = null;
      }
      unregisterAtom(atomKey);
      unsubscribeCoordinator?.();
      unsubscribeCoordinator = null;
    };
  });

  // --- Exposed Atom ---
  // Define the reload function correctly
  const reload = async (): Promise<void> => {
      // Ensure the task runs even if currently idle/successful
      // Set loading state immediately for feedback
      if (isMounted && enabled) {
          queryMapAtom.setKey('status', 'loading');
          queryMapAtom.setKey('loading', true);
          queryMapAtom.setKey('error', null);
          await fetcher(); // Call the original fetcher function directly
      } else {
          // Optionally warn if trying to reload when disabled or unmounted
          console.warn(`[zenQuery][${atomKey}] Reload called but query is disabled or unmounted.`);
      }
  };

  const exposedAtom = {
    ...queryMapAtom,
    key: atomKey,
    reload: reload, // Assign the reload function
  };

  // Cast to satisfy the interface
  return exposedAtom as QueryAtom<TOutput, TError>;
}