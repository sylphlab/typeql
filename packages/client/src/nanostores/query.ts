import { map, onMount, task, computed, type ReadableAtom, type Atom, type Store } from 'nanostores';
import type { Patch } from 'immer'; // Immer patches for optimistic updates
import { Operation } from 'fast-json-patch'; // Use standard named import

import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches } from './patchUtils'; // Use Immer utils
import { applyJsonDelta } from './stateUtils'; // Use JSON Patch delta applicator

// Local definition as workaround for import issues - REMOVED, using direct import now

// Define the shape of the state managed by the query map atom
export interface QueryMapState<TData = unknown, TError = Error> {
  data: TData | undefined;
  loading: boolean;
  error: TError | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  // Add other relevant state like lastUpdated, etc. if needed
}

// Define options for the query helper - input is now optional here, required by procedure
export interface QueryOptions<TInput = unknown, TData = unknown> {
  initialData?: TData;
  enabled?: boolean; // Default: true
  input?: TInput; // Input is now optional in options, passed to procedure
  // Add other options like staleTime, cacheTime, refetchOnMount, etc. later
}

// Type for the selector function to get the client instance, procedure, and path
// EXPORT this type
export type ProcedureClientPathSelector<TClient extends ZenQueryClient, TProcedureResult> = (
  get: <TValue>(atom: ReadableAtom<TValue> | Store<TValue>) => TValue // Nanostores 'get' function type
) => { client: TClient; procedure: TProcedureResult; path: string | string[] }; // Selector provides path

// Type for the returned atom, including potential actions
// Use ReadableAtom<QueryMapState> as the base
export interface QueryAtom<TData = unknown, TError = Error> extends ReadableAtom<QueryMapState<TData, TError>> {
  readonly key: AtomKey; // Key should be readonly externally
  reload: () => Promise<void>; // Add reload function
}

/**
 * Creates a Nanostore map atom to manage the state of a ZenQuery query.
 *
 * @param procedureSelector A selector function returning the client, procedure, and path.
 * @param options Query configuration options including optional input and initialData.
 * @returns A readable Nanostore map atom representing the query state with a reload method.
 */
export function query<
  TClient extends ZenQueryClient,
  TInput = unknown,
  // Constrain TOutput to object or array for Immer compatibility
  TOutput extends object | unknown[] = any,
  TError = Error,
  // Infer the procedure type from the selector result
  TProcedure extends { query: (input: TInput, opts: { signal?: AbortSignal }) => Promise<TOutput> } = any
>(
  procedureSelector: ProcedureClientPathSelector<TClient, TProcedure>,
  options?: QueryOptions<TInput, TOutput> // Options are now optional
): QueryAtom<TOutput, TError> {

  const { initialData, enabled = true, input } = options ?? {}; // Handle potentially undefined options

  // Use computed with single argument, relying on inference (Error likely persists here)
  const $procedureClientPath = computed(procedureSelector);

  // Determine the stable atom key based on the initial selector result and input
  // Add non-null assertion assuming selector always returns a value initially.
  const { path: initialPath } = $procedureClientPath.get()!; // Error likely persists here
  const stableAtomKey = generateAtomKey(initialPath, input);

  // Use a map atom to hold the query state
  const queryMapAtom = map<QueryMapState<TOutput, TError>>({
    data: initialData,
    loading: enabled, // Start loading if enabled based on initial state
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

  // Needs access to coordinator, confirmedServerData, stableAtomKey, queryMapAtom
  const computeOptimisticState = (coordinator: OptimisticSyncCoordinator) => {
    if (!isMounted) return;

    const currentMapState = queryMapAtom.get();
    const pendingPatchesMap = coordinator.getPendingPatches();
    const patchesForThisAtom = pendingPatchesMap.get(stableAtomKey) || [];

    let optimisticData: TOutput | undefined;
    let computationError: Error | null = null;

    if (patchesForThisAtom.length === 0) {
      optimisticData = confirmedServerData;
    } else {
      try {
        const baseState = confirmedServerData ?? ({} as TOutput);
        optimisticData = applyImmerPatches(baseState as any, patchesForThisAtom);
      } catch (error) {
        console.error(`[zenQuery][${stableAtomKey}] Failed to apply optimistic patches:`, error);
        computationError = error instanceof Error ? error : new Error('Failed to compute optimistic state');
        optimisticData = confirmedServerData; // Fallback
      }
    }

    if (currentMapState.data !== optimisticData || currentMapState.error !== computationError) {
        queryMapAtom.setKey('data', optimisticData);
        if (computationError && !currentMapState.error) {
            queryMapAtom.setKey('error', computationError as TError);
            queryMapAtom.setKey('status', 'error');
        } else if (!computationError && currentMapState.error) {
            queryMapAtom.setKey('error', null);
            // Status is managed by fetch/delta handlers
        }
    }
  };

  // Needs access to confirmedServerData, stableAtomKey, queryMapAtom, coordinator (for computeOptimisticState)
  const applyServerDelta = (coordinator: OptimisticSyncCoordinator, deltaPatches: readonly Operation[]) => { // Use imported Operation
    if (!isMounted) return;
    try {
      const newState = applyJsonDelta(confirmedServerData, deltaPatches);
      confirmedServerData = newState;
      computeOptimisticState(coordinator); // Recompute optimistic state
    } catch (error) {
      console.error(`[zenQuery][${stableAtomKey}] Failed to apply server delta:`, error);
      queryMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Failed to apply server delta') as TError);
      queryMapAtom.setKey('status', 'error');
    }
  };

  // Core fetch logic
  const fetcher = async () => {
    // Get fresh client/procedure for this fetch using the computed atom
    // Add non-null assertion assuming it's available when fetcher runs
    const { client, procedure } = $procedureClientPath.get()!; // Error likely persists here
    const coordinator = client.getCoordinator();

    // Abort previous fetch if running
    if (currentAbortController) {
        currentAbortController.abort();
        console.log(`[zenQuery][${stableAtomKey}] Aborted previous fetch.`);
    }
    const abortController = new AbortController();
    currentAbortController = abortController;
    const signal = abortController.signal;

    // Don't fetch if not enabled or not mounted
    // Check enabled status reactively? For now, check initial enabled status.
    if (!isMounted || !enabled) {
        queryMapAtom.setKey('loading', false);
        queryMapAtom.setKey('status', 'idle');
        currentAbortController = null;
        return;
    };

    try {
      // Set loading state
      queryMapAtom.setKey('loading', true);
      queryMapAtom.setKey('status', 'loading');
      queryMapAtom.setKey('error', null); // Clear error on new fetch

      if (signal.aborted) {
          console.log(`[zenQuery][${stableAtomKey}] Fetch aborted before start.`);
          queryMapAtom.setKey('loading', false);
          queryMapAtom.setKey('status', queryMapAtom.get().data !== undefined ? 'success' : 'idle');
          return;
      }

      // Use the resolved procedure and input from options
      const result = await procedure.query(input as TInput, { signal }); // Pass input

      if (signal.aborted || currentAbortController !== abortController) {
          console.log(`[zenQuery][${stableAtomKey}] Fetch aborted or superseded after completion.`);
          return;
      }

      confirmedServerData = result as TOutput;
      queryMapAtom.setKey('loading', false);
      queryMapAtom.setKey('status', 'success');
      computeOptimisticState(coordinator); // Recompute optimistic state

    } catch (error: any) {
        if ((signal.aborted || error.name === 'AbortError') && currentAbortController === abortController) {
            console.log(`[zenQuery][${stableAtomKey}] Fetch explicitly aborted.`);
            if (queryMapAtom.get().loading) {
                queryMapAtom.setKey('loading', false);
                queryMapAtom.setKey('status', queryMapAtom.get().data !== undefined ? 'success' : 'idle');
            }
            return;
        } else if (currentAbortController !== abortController) {
            console.log(`[zenQuery][${stableAtomKey}] Ignored error from stale fetch.`);
            return;
        }

      console.error(`[zenQuery][${stableAtomKey}] Fetch failed:`, error);
      queryMapAtom.setKey('loading', false);
      queryMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Query failed') as TError);
      queryMapAtom.setKey('status', 'error');
      computeOptimisticState(coordinator); // Recompute optimistic state (falls back to confirmed)
    } finally {
        if (currentAbortController === abortController) {
            currentAbortController = null;
        }
    }
  };

  // Wrap fetcher with task for concurrency control
  const fetchData = task(fetcher); // Error likely persists here

  // Reload function
  const reload = async (): Promise<void> => {
      if (isMounted && enabled) {
          await fetchData(); // Error likely persists here
      } else {
          console.warn(`[zenQuery][${stableAtomKey}] Reload called but query is disabled or unmounted.`);
      }
  };

  // --- Lifecycle ---
  onMount(queryMapAtom, () => {
    isMounted = true;
    // Get coordinator instance needed for listeners
    // Add non-null assertion
    const { client } = $procedureClientPath.get()!; // Error likely persists here
    const coordinator = client.getCoordinator();

    registerAtom(stableAtomKey, queryMapAtom);

    // Setup listeners, passing coordinator instance
    const unsubChange = coordinator.onStateChange(() => computeOptimisticState(coordinator));
    const unsubDelta = coordinator.onApplyDelta((delta: ServerDelta) => {
      if (delta.key === stableAtomKey) {
        applyServerDelta(coordinator, delta.patches);
      }
    });

    unsubscribeCoordinator = () => {
      unsubChange();
      unsubDelta();
    };

    // Initial fetch logic
    if (enabled) {
        fetchData(); // Error likely persists here
    } else {
        queryMapAtom.setKey('status', 'idle');
        queryMapAtom.setKey('loading', false);
    }

    return () => { // Cleanup function
      isMounted = false;
      if (currentAbortController) {
          currentAbortController.abort();
          currentAbortController = null;
      }
      unregisterAtom(stableAtomKey);
      unsubscribeCoordinator?.();
      unsubscribeCoordinator = null;
    };
  });

  // --- Exposed Atom ---
  // Add properties directly to the map atom instance and cast
  const finalAtom = queryMapAtom as any; // Use 'any' temporarily to bypass cast error
  finalAtom.key = stableAtomKey;
  finalAtom.reload = reload;

  // Return the enhanced atom instance
  return finalAtom as QueryAtom<TOutput, TError>; // Cast back
}