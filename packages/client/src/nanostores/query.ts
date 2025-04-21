import { map, onMount, type ReadableAtom, type Atom, type Store } from 'nanostores'; // Remove get
// Remove import from @nanostores/core
// Replace Immer Patch with fast-json-patch Operation and applyPatch
import { applyPatch, type Operation } from 'fast-json-patch';

import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta } from '../coordinator';
// Remove getAtom import
import { generateAtomKey, registerAtom, unregisterAtom, type AtomKey } from '../utils/atomRegistry';
// Remove applyImmerPatches import
// import { applyImmerPatches } from './patchUtils';
// Remove applyJsonDelta import (we'll use applyPatch directly)
// import { applyJsonDelta } from './stateUtils';

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
// Updated Return Type: No longer includes client, path is array or string, includes marker.
// TProcedureResult now represents the inner procedure object, e.g., { query: Func }
// Path is now always a string derived by the proxy.
export type ProcedureClientPathSelector<TProcedureResult> = (
  client: ZenQueryClient // Receives the client instance directly
) => { path: string; procedure: TProcedureResult; _isZenQueryProcedure: true };

// Type for the returned atom, including potential actions
// Use ReadableAtom<QueryMapState> as the base
export interface QueryAtom<TData = unknown, TError = Error> extends ReadableAtom<QueryMapState<TData, TError>> {
  readonly key: AtomKey; // Key should be readonly externally
  reload: () => Promise<void>; // Add reload function
}

/**
 * Creates a Nanostore map atom to manage the state of a ZenQuery query.
 *
 * @param $clientAtom The Nanostore atom holding the ZenQueryClient instance.
 * @param procedureSelector A selector function receiving the client and returning the procedure and path.
 * @param options Query configuration options including optional input and initialData.
 * @returns A readable Nanostore map atom representing the query state with a reload method.
 */
export function query<
  TInput = unknown,
  // Constrain TOutput to object or array for Immer compatibility
  TOutput extends object | unknown[] = any,
  TError = Error,
  // TProcedure now represents the inner object like { query: Func }
  TProcedure extends { query: (input: TInput, opts?: { signal?: AbortSignal }) => Promise<TOutput> } = any
>(
  $clientAtom: ReadableAtom<ZenQueryClient>, // Add $clientAtom parameter
  procedureSelector: ProcedureClientPathSelector<TProcedure>,
  options?: QueryOptions<TInput, TOutput> // Options are now optional
): QueryAtom<TOutput, TError> {

  const { initialData, enabled = true, input } = options ?? {}; // Handle potentially undefined options

  // --- Key Generation (Requires non-reactive client access) ---
  // We still need the path for the key *before* mount.
  // Assume the selector can be called with a temporary client instance
  // or that the path doesn't depend on reactive client state.
  // This is a potential design constraint: selectors used for key generation
  // should ideally not depend on reactive client state.
  let initialPath: string;
  try {
      // Get a client instance non-reactively for key generation
      // This relies on the client atom having a value immediately or being setup beforehand.
      const tempClient = $clientAtom.get(); // Get client non-reactively
      if (!tempClient) {
          throw new Error("Client atom has no value during initial setup for key generation.");
      }
      const preliminaryResult = procedureSelector(tempClient); // Call with client
      if (typeof preliminaryResult?.path !== 'string' || !preliminaryResult?._isZenQueryProcedure) {
          throw new Error("Selector did not return the expected { path: string, procedure: ..., _isZenQueryProcedure: true } object.");
      }
      initialPath = preliminaryResult.path;
  } catch (e) {
      console.error("[zenQuery] Failed preliminary selector call for key generation:", e);
      throw new Error(`[zenQuery] Failed to determine initial path from procedureSelector: ${e instanceof Error ? e.message : String(e)}`);
  }
  const stableAtomKey = generateAtomKey(initialPath, input);
  // --- End Key Generation ---

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
    // Use Operation[] type
    const pendingPatchesMap = coordinator.getPendingPatches();
    const patchesForThisAtom: Operation[] = pendingPatchesMap.get(stableAtomKey) || []; // Use Operation[]

    let optimisticData: TOutput | undefined;
    let computationError: Error | null = null;

    if (patchesForThisAtom.length === 0) {
      optimisticData = confirmedServerData;
    } else {
      try {
        // Clone base state before applying patches as applyPatch mutates
        const baseState = confirmedServerData ? structuredClone(confirmedServerData) : ({} as TOutput);
        // Apply patches using fast-json-patch's applyPatch
        const patchResult = applyPatch(baseState, patchesForThisAtom, true, false); // validate = true, mutateDocument = false (already cloned)
        optimisticData = patchResult.newDocument;
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
  const applyServerDelta = (coordinator: OptimisticSyncCoordinator, deltaPatches: readonly Operation[]) => { // Use Operation[]
    if (!isMounted) return;
    try {
      // Clone base state before applying patches as applyPatch mutates
      const baseState = confirmedServerData ? structuredClone(confirmedServerData) : ({} as TOutput);
      // Apply patches using fast-json-patch's applyPatch
      const patchResult = applyPatch(baseState, deltaPatches, true, false); // validate = true, mutateDocument = false (already cloned)
      confirmedServerData = patchResult.newDocument;
      computeOptimisticState(coordinator); // Recompute optimistic state
    } catch (error) {
      console.error(`[zenQuery][${stableAtomKey}] Failed to apply server delta:`, error);
      queryMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Failed to apply server delta') as TError);
      queryMapAtom.setKey('status', 'error');
    }
  };

  // Core fetch logic - Will be defined inside onMount
  // Correct fetcher type to accept client and coordinator
  let fetcher: ((client: ZenQueryClient, coord: OptimisticSyncCoordinator) => Promise<void>) | null = null;
  // Remove task wrapper
  // let _fetchDataTask: ReturnType<typeof task> | null = null;

  // Reload function - Defined outside, calls fetcher defined in onMount
  const reload = async (): Promise<void> => {
      // Get client and coordinator from the provided atom
      const client = $clientAtom.get();
      if (!client) {
          console.error(`[zenQuery][${stableAtomKey}] Reload failed: Client atom has no value.`);
          return;
      }
      const coordinator = client.getCoordinator();

      if (fetcher && isMounted && enabled) { // Check if fetcher is defined and mounted/enabled
          await fetcher(client, coordinator); // Pass client and coordinator
      } else {
          console.warn(`[zenQuery][${stableAtomKey}] Reload called before mount or query is disabled/fetcher not ready.`);
      }
  };


  // --- Lifecycle ---
  onMount(queryMapAtom, () => {
    isMounted = true;

    // --- Resolve reactive values inside onMount ---
    const client = $clientAtom.get(); // Get client from the atom
    if (!client) {
        console.error(`[zenQuery][${stableAtomKey}] Mount failed: Client atom has no value.`);
        queryMapAtom.setKey('error', new Error('Internal configuration error: Client not available') as TError);
        queryMapAtom.setKey('status', 'error');
        queryMapAtom.setKey('loading', false);
        return; // Abort mount setup
    }
    const coordinator = client.getCoordinator();

    // Call selector here to get reactive procedure and verify structure
    const selectorResult = procedureSelector(client); // Pass client instance
    if (typeof selectorResult?.path !== 'string' || !selectorResult?.procedure?.query || !selectorResult?._isZenQueryProcedure) {
        // Handle error state appropriately
        console.error(`[zenQuery][${stableAtomKey}] Invalid result from procedureSelector in onMount. Expected { path: string, procedure: { query: Func }, _isZenQueryProcedure: true }`, selectorResult);
        queryMapAtom.setKey('error', new Error('Internal configuration error: Invalid procedure selector result') as TError);
        queryMapAtom.setKey('status', 'error');
        queryMapAtom.setKey('loading', false);
        return; // Abort mount setup
    }
    const { procedure } = selectorResult;
    // ---

    // Define fetcher function within onMount scope to accept client and coordinator
    // Correctly assign fetcher with the right signature
    fetcher = async (client: ZenQueryClient, coord: OptimisticSyncCoordinator) => { // Use correct parameter names matching type
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

      if (signal.aborted) {
          console.log(`[zenQuery][${stableAtomKey}] Fetch aborted before start.`);
          queryMapAtom.setKey('loading', false);
          queryMapAtom.setKey('status', queryMapAtom.get().data !== undefined ? 'success' : 'idle');
          return;
      }

      // Use the resolved procedure.query and input from options
      const result = await procedure.query(input as TInput, { signal }); // Pass input

      if (signal.aborted || currentAbortController !== abortController) {
          console.log(`[zenQuery][${stableAtomKey}] Fetch aborted or superseded after completion.`);
          return;
      }

      confirmedServerData = result as TOutput;
      queryMapAtom.setKey('loading', false);
      queryMapAtom.setKey('status', 'success');
      computeOptimisticState(coord); // Use passed coordinator

    } catch (error: any) { // Restore correct catch block structure
        // Check signal first
        if (signal.aborted) {
            console.log(`[zenQuery][${stableAtomKey}] Fetch explicitly aborted.`);
            // Only reset loading state if this controller was the current one
            if (currentAbortController === abortController) {
                queryMapAtom.setKey('loading', false);
                queryMapAtom.setKey('status', queryMapAtom.get().data !== undefined ? 'success' : 'idle');
            }
            // Don't proceed to error handling if aborted
            return;
        }

        // Check if superseded *after* checking signal
        if (currentAbortController !== abortController) {
            console.log(`[zenQuery][${stableAtomKey}] Ignored error from stale fetch.`);
            return;
        }

        // Handle non-abort errors
        console.error(`[zenQuery][${stableAtomKey}] Fetch failed:`, error);
        queryMapAtom.setKey('loading', false);
        queryMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Query failed') as TError);
        queryMapAtom.setKey('status', 'error');
        computeOptimisticState(coord); // Recompute state even on error

    } finally { // Restore correct finally block structure
        // Clear controller only if it's the current one
        if (currentAbortController === abortController) {
            currentAbortController = null;
        }
    }
    }; // End of fetcher async function

    // Remove task wrapper
    // _fetchDataTask = task(_fetcher);

    registerAtom(stableAtomKey, queryMapAtom);

    // Setup listeners, passing coordinator instance (already defined above)
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
    if (enabled && fetcher) { // Check fetcher directly
        fetcher(client, coordinator); // Pass client and coordinator
    } else {
        queryMapAtom.setKey('status', 'idle');
        queryMapAtom.setKey('loading', false);
    }

    // Correct return type for onMount cleanup
    return (): void => { // Cleanup function must return void
      isMounted = false;
      if (currentAbortController) {
          currentAbortController.abort();
          currentAbortController = null;
      }
      unregisterAtom(stableAtomKey);
      unsubscribeCoordinator?.();
      unsubscribeCoordinator = null;
    };
  }); // End of onMount

  // --- Exposed Atom (Move inside function scope) ---
  // Add properties directly to the map atom instance and cast
  const finalAtom = queryMapAtom as any; // Use 'any' temporarily to bypass cast error
  finalAtom.key = stableAtomKey;
  finalAtom.reload = reload;

  // Return the enhanced atom instance
  return finalAtom as QueryAtom<TOutput, TError>; // Cast back
} // End of query function