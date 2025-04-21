import { map, onMount, type ReadableAtom, type Atom, type Store } from 'nanostores'; // Remove get
// Remove import from @nanostores/core
// Use fast-json-patch Operation and applyPatch
import { applyPatch, type Operation } from 'fast-json-patch';
// Also import Immer Patch for rollback
import type { Patch } from 'immer';
// Import ProcedureClientPathSelector from query.ts
import { type ProcedureClientPathSelector } from './query'; // Import selector type
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta, CoordinatorEvents } from '../coordinator'; // Added CoordinatorEvents
// Remove getAtom import
import { generateAtomKey, registerAtom, unregisterAtom, type AtomKey } from '../utils/atomRegistry';
// Re-import applyImmerPatches for rollback
import { applyImmerPatches } from './patchUtils';
// Remove applyJsonDelta import
// import { applyJsonDelta } from './stateUtils';

// Remove local PatchOperation definition


// Define the shape of the state managed by the subscription map atom
export type SubscriptionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface SubscriptionAtomState<TData = unknown, TError = Error> {
  data: TData | undefined;
  status: SubscriptionStatus;
  error: TError | null;
  // Add other relevant state like lastUpdated, etc. if needed
}

// Define options for the subscription helper - input is optional
export interface SubscriptionOptions<TInput = unknown, TData = unknown> {
  initialData?: TData; // Optional initial data before connection
  enabled?: boolean; // Default: true
  input?: TInput; // Input is optional here
  // Add other options like retry logic later
}

// Remove local type definition - will import from query.ts
// type ProcedureClientPathSelector<...> = ...

// Type for the returned atom
export interface SubscriptionAtom<TData = unknown, TError = Error> extends ReadableAtom<SubscriptionAtomState<TData, TError>> {
  readonly key: AtomKey;
  // Add actions like reconnect later?
}

// Define the callback interface locally based on usage
interface SubscriptionCallbacks<TData = unknown, TError = Error> {
    onData: (data: TData | Operation[]) => void; // Use fast-json-patch Operation[]
    onError: (error: TError | Error | any) => void;
    onComplete: () => void;
    // onOpen?: () => void;
}


/**
 * Creates a Nanostore map atom to manage the state of a ZenQuery subscription.
 *
 * @param $clientAtom The Nanostore atom holding the ZenQueryClient instance.
 * @param procedureSelector A selector function receiving the client and returning the procedure and path.
 * @param options Subscription configuration options including optional input and initialData.
 * @returns A readable Nanostore map atom representing the subscription state.
 */
export function subscription<
  TInput = unknown,
  // Constrain TOutput to object or array for Immer compatibility
  TOutput extends object | unknown[] = any,
  TError = Error,
  // Infer procedure type from selector - TProcedure is now inner object { subscribe: Func }
  TProcedure extends { subscribe: (input: TInput, callbacks: SubscriptionCallbacks<TOutput, TError>) => { unsubscribe: () => void } } = any
>(
  $clientAtom: ReadableAtom<ZenQueryClient>, // Add $clientAtom parameter
  procedureSelector: ProcedureClientPathSelector<TProcedure>,
  options?: SubscriptionOptions<TInput, TOutput>
): SubscriptionAtom<TOutput, TError> {

  const { initialData, enabled = true, input } = options ?? {};

  // --- Key Generation (Requires non-reactive client access) ---
  let initialPath: string;
  try {
      // Get client non-reactively for key generation
      const tempClient = $clientAtom.get();
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

  // Use a map atom to hold the subscription state
  const subscriptionMapAtom = map<SubscriptionAtomState<TOutput, TError>>({
    data: initialData,
    status: 'idle', // Start idle, connect on mount
    error: null,
  });

  // --- Internal State ---
  let isMounted = false;
  let confirmedServerData: TOutput | undefined = initialData;
  let unsubscribeCoordinator: (() => void) | null = null;
  let clientUnsubscribeFn: (() => void) | null = null; // Function to call client.unsubscribe

  // --- Logic Functions (Similar to query, adapted for subscription) ---

  const computeOptimisticState = (coordinator: OptimisticSyncCoordinator) => {
    if (!isMounted) return;
    const currentMapState = subscriptionMapAtom.get();
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
        subscriptionMapAtom.setKey('data', optimisticData);
        if (computationError && !currentMapState.error) {
            subscriptionMapAtom.setKey('error', computationError as TError);
            subscriptionMapAtom.setKey('status', 'error');
        } else if (!computationError && currentMapState.error) {
            subscriptionMapAtom.setKey('error', null);
            // Status managed by connect/delta handlers
        }
    }
  };

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
      subscriptionMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Failed to apply server delta') as TError);
      subscriptionMapAtom.setKey('status', 'error');
    }
  };

  const applyServerSnapshot = (coordinator: OptimisticSyncCoordinator, snapshotData: TOutput) => {
      if (!isMounted) return;
      confirmedServerData = snapshotData;
      computeOptimisticState(coordinator); // Recompute optimistic state after snapshot
  };

  // --- Connection Logic - Define inside onMount ---
  let connectSubscription: (() => void) | null = null;
  let disconnectSubscription: (() => void) | null = null;


  // --- Lifecycle ---
  onMount(subscriptionMapAtom, () => {
    isMounted = true;

    // --- Resolve reactive values inside onMount ---
    const client = $clientAtom.get(); // Get client from the atom
    if (!client) {
        console.error(`[zenQuery][${stableAtomKey}] Mount failed: Client atom has no value.`);
        subscriptionMapAtom.setKey('error', new Error('Internal configuration error: Client not available') as TError);
        subscriptionMapAtom.setKey('status', 'error');
        return; // Abort mount setup
    }
    const coordinator = client.getCoordinator();

    // Call selector here to get reactive procedure and verify structure
    const selectorResult = procedureSelector(client); // Pass client instance
    if (typeof selectorResult?.path !== 'string' || !selectorResult?.procedure?.subscribe || !selectorResult?._isZenQueryProcedure) {
        // Handle error state appropriately
        console.error(`[zenQuery][${stableAtomKey}] Invalid result from procedureSelector in onMount. Expected { path: string, procedure: { subscribe: Func }, _isZenQueryProcedure: true }`, selectorResult);
        subscriptionMapAtom.setKey('error', new Error('Internal configuration error: Invalid procedure selector result') as TError);
        subscriptionMapAtom.setKey('status', 'error');
        return; // Abort mount setup
    }
    const { procedure } = selectorResult;
    // ---

    // Define connection logic inside onMount to access reactive procedure/coordinator
    connectSubscription = () => {
      if (!isMounted || clientUnsubscribeFn || !enabled) return;

      subscriptionMapAtom.setKey('status', 'connecting');
      subscriptionMapAtom.setKey('error', null);

    try {
      // Define callbacks for the client subscription
      const callbacks: SubscriptionCallbacks<TOutput, TError> = {
        onData: (data: TOutput | Operation[]) => { // Use Operation[]
          if (!isMounted) return;
          // Basic check: Assume array is JSON Patch delta (Operation[])
          if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && 'op' in data[0] && 'path' in data[0]) {
             applyServerDelta(coordinator, data as Operation[]); // Pass coordinator
          } else { // Assume full snapshot
             applyServerSnapshot(coordinator, data as TOutput); // Pass coordinator
          }
          if (subscriptionMapAtom.get().status === 'connecting') {
              subscriptionMapAtom.setKey('status', 'connected');
          }
        },
        onError: (error: TError | Error | any) => {
          console.error(`[zenQuery][${stableAtomKey}] Subscription error:`, error);
          if (isMounted) {
            subscriptionMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Subscription failed') as TError);
            subscriptionMapAtom.setKey('status', 'error');
          }
          disconnectSubscription?.(); // Add null check
        },
        onComplete: () => {
          if (isMounted) {
            subscriptionMapAtom.setKey('status', 'closed');
          }
          disconnectSubscription?.(); // Add null check
        },
      };

      const { unsubscribe } = procedure.subscribe(input as TInput, callbacks);
      clientUnsubscribeFn = unsubscribe; // Store the unsubscribe function

      // Optimistically set to connected
      if (subscriptionMapAtom.get().status === 'connecting') {
          subscriptionMapAtom.setKey('status', 'connected');
      }

    } catch (error) {
      console.error(`[zenQuery][${stableAtomKey}] Failed to initiate subscription:`, error);
      if (isMounted) {
        subscriptionMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Failed to start subscription') as TError);
        subscriptionMapAtom.setKey('status', 'error');
      }
      }
    };

    disconnectSubscription = () => {
      if (clientUnsubscribeFn) {
        try {
          clientUnsubscribeFn();
        } catch (error) {
          console.error(`[zenQuery][${stableAtomKey}] Error during unsubscribe:`, error);
        }
        clientUnsubscribeFn = null;
        if (isMounted && subscriptionMapAtom.get().status !== 'error') {
            subscriptionMapAtom.setKey('status', 'closed');
        }
      }
    };

    registerAtom(stableAtomKey, subscriptionMapAtom);

    // Subscribe to coordinator events (coordinator already defined above)
    const unsubChange = coordinator.onStateChange(() => computeOptimisticState(coordinator));
    const unsubDelta = coordinator.onApplyDelta((delta: ServerDelta) => {
      if (delta.key === stableAtomKey) {
        // Ensure delta.patches is treated as Operation[]
        applyServerDelta(coordinator, delta.patches as Operation[]);
      }
    });
    // Use Immer Patch[] for rollback patches as required by coordinator signature
    const unsubRollback = coordinator.onRollback((inversePatchesByAtom: Map<AtomKey, Patch[]>) => { // Use Patch[]
        const inversePatches = inversePatchesByAtom.get(stableAtomKey);
        if (inversePatches && inversePatches.length > 0) {
            console.warn(`[zenQuery][${stableAtomKey}] Rolling back optimistic updates due to mutation failure.`);
            // TODO: Add comment explaining coordinator inconsistency (uses Operation elsewhere, Patch here)
            try {
                // Apply rollback patches using Immer patch applicator
                const baseState = confirmedServerData ?? ({} as TOutput);
                // Assuming applyImmerPatches handles cloning or works immutably
                confirmedServerData = applyImmerPatches(baseState as any, inversePatches);
                computeOptimisticState(coordinator); // Recompute state after rollback
            } catch (error) {
                console.error(`[zenQuery][${stableAtomKey}] Error applying rollback patches:`, error);
                subscriptionMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Rollback failed') as TError);
                subscriptionMapAtom.setKey('status', 'error');
            }
        }
    });


    unsubscribeCoordinator = () => {
      unsubChange();
      unsubDelta();
      unsubRollback();
    };

    // Connect the subscription if enabled
    if (enabled && connectSubscription) { // Check connectSubscription exists
      connectSubscription();
    } else {
      subscriptionMapAtom.setKey('status', 'idle');
    }

    return () => { // Cleanup function
      isMounted = false;
      if (disconnectSubscription) disconnectSubscription(); // Disconnect the actual subscription
      unregisterAtom(stableAtomKey);
      unsubscribeCoordinator?.();
      unsubscribeCoordinator = null;
      // Reset connection functions
      connectSubscription = null;
      disconnectSubscription = null;
    };
  });

  // --- Exposed Atom ---
  const finalAtom = subscriptionMapAtom as any; // Use 'any' temporarily
  finalAtom.key = stableAtomKey;
  // No reload function for subscriptions currently

  return finalAtom as SubscriptionAtom<TOutput, TError>; // Cast back
}