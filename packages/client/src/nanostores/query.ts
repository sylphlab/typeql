import { map, onMount, get, type ReadableAtom, type Atom, type Store } from 'nanostores'; // Restore get
// Remove import from @nanostores/core
// Replace Immer Patch with fast-json-patch Operation and applyPatch
import { applyPatch, type Operation } from 'fast-json-patch';

import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta } from '../coordinator';
// Add getAtom to import
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
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
  get: <TValue>(atom: ReadableAtom<TValue> | Store<TValue>) => TValue // Nanostores 'get' function type
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
 * @param procedureSelector A selector function returning the client, procedure, and path.
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
  // Remove TClient from selector type argument
  procedureSelector: ProcedureClientPathSelector<TProcedure>,
  options?: QueryOptions<TInput, TOutput> // Options are now optional
): QueryAtom<TOutput, TError> {

  const { initialData, enabled = true, input } = options ?? {}; // Handle potentially undefined options

  // --- Preliminary call for stable key generation ---
  // Define a dummy 'get' that throws, assuming selector doesn't need reactive values initially
  const dummyGet = <T>(_: ReadableAtom<T> | Store<T>): T => {
      throw new Error('[zenQuery] Preliminary selector call tried to use `get`. Selector should not depend on other stores for initial path/procedure determination.');
  };
  let initialPath: string; // Path is now always a string
  try {
      // Call selector once just to get the path string
      const preliminaryResult = procedureSelector(dummyGet);
      if (typeof preliminaryResult?.path !== 'string' || !preliminaryResult?._isZenQueryProcedure) {
          throw new Error("Selector did not return the expected { path: string, procedure: ..., _isZenQueryProcedure: true } object.");
      }
      initialPath = preliminaryResult.path;
  } catch (e) {
      console.error("[zenQuery] Failed preliminary selector call for key generation:", e);
      // Fallback or re-throw? Let's throw to make the configuration error obvious.
      throw new Error(`[zenQuery] Failed to determine initial path from procedureSelector: ${e instanceof Error ? e.message : String(e)}`);
  }
  const stableAtomKey = generateAtomKey(initialPath, input);
  // --- End Preliminary call ---

  // Remove computed wrapper entirely
  // const $procedurePathObj = computed(procedureSelector) as any; // TODO: Fix computed type inference issue

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
  let fetcher: ((coord: OptimisticSyncCoordinator) => Promise<void>) | null = null; // Update type to accept coordinator
  // Remove task wrapper
  // let _fetchDataTask: ReturnType<typeof task> | null = null;

  // Reload function - Defined outside, calls fetcher defined in onMount
  const reload = async (): Promise<void> => {
      // Resolve coordinator within reload as well, in case it's called outside mount context
      const clientAtom = getAtom('zenQueryClient') as Atom<ZenQueryClient> | undefined;
      if (!clientAtom) {
          console.error(`[zenQuery][${stableAtomKey}] Reload failed: Client atom not found.`);
          return;
      }
      const coordinator = clientAtom.get().getCoordinator();

      if (fetcher && isMounted && enabled) { // Check if fetcher is defined and mounted/enabled
          await fetcher(coordinator); // Pass coordinator
      } else {
          console.warn(`[zenQuery][${stableAtomKey}] Reload called before mount or query is disabled/fetcher not ready.`);
      }
  };


  // --- Lifecycle ---
  onMount(queryMapAtom, () => {
    isMounted = true;

    // --- Resolve reactive values inside onMount ---
    // Call selector here to get reactive procedure and verify structure
    const selectorResult = procedureSelector(get); // Use real 'get' from onMount
    if (typeof selectorResult?.path !== 'string' || !selectorResult?.procedure?.query || !selectorResult?._isZenQueryProcedure) {
        // Handle error state appropriately - maybe set error in atom?
        console.error(`[zenQuery][${stableAtomKey}] Invalid result from procedureSelector in onMount. Expected { path: string, procedure: { query: Func }, _isZenQueryProcedure: true }`, selectorResult);
        queryMapAtom.setKey('error', new Error('Internal configuration error: Invalid procedure selector result') as TError);
        queryMapAtom.setKey('status', 'error');
        queryMapAtom.setKey('loading', false);
        return; // Abort mount setup
    }
    const { procedure } = selectorResult;

    // TODO: [TECH DEBT] Revisit coordinator access. Helpers should ideally receive client/coordinator via context or options.
    const clientAtom = getAtom('zenQueryClient') as Atom<ZenQueryClient> | undefined; // Placeholder for coordinator access
    if (!clientAtom) throw new Error("[zenQuery] Client atom ('zenQueryClient') not found. Ensure provider is set up or client is passed differently.");
    const coordinator = clientAtom.get().getCoordinator();
    // ---

    // Define fetcher function within onMount scope to accept coordinator
    fetcher = async (coord: OptimisticSyncCoordinator) => { // Accept coordinator
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
      computeOptimisticState(coord); // Use passed coordinator
    } finally {
        if (currentAbortController === abortController) {
            currentAbortController = null;
        }
      }
    };

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
        fetcher(coordinator); // Pass coordinator
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