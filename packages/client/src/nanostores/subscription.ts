import { map, onMount, computed, type ReadableAtom, type Atom, type Store } from 'nanostores'; // Removed task, added computed, Store
import type { Patch } from 'immer'; // Immer patches for optimistic updates
// import { Operation } from 'fast-json-patch'; // Use standard named import - Reverted
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches } from './patchUtils'; // Use Immer utils
import { applyJsonDelta } from './stateUtils'; // Use JSON Patch delta applicator

// Local definition as workaround for import issues
interface PatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: any;
  from?: string;
}


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

// Type for the selector function (same as query)
type ProcedureClientPathSelector<TClient extends ZenQueryClient, TProcedureResult> = (
  get: <TValue>(atom: ReadableAtom<TValue> | Store<TValue>) => TValue
) => { client: TClient; procedure: TProcedureResult; path: string | string[] };

// Type for the returned atom
export interface SubscriptionAtom<TData = unknown, TError = Error> extends ReadableAtom<SubscriptionAtomState<TData, TError>> {
  readonly key: AtomKey;
  // Add actions like reconnect later?
}

// Define the callback interface locally based on usage
interface SubscriptionCallbacks<TData = unknown, TError = Error> {
    onData: (data: TData | PatchOperation[]) => void; // Use local PatchOperation
    onError: (error: TError | Error | any) => void;
    onComplete: () => void;
    // onOpen?: () => void;
}


/**
 * Creates a Nanostore map atom to manage the state of a ZenQuery subscription.
 *
 * @param procedureSelector A selector function returning the client, procedure, and path.
 * @param options Subscription configuration options including optional input and initialData.
 * @returns A readable Nanostore map atom representing the subscription state.
 */
export function subscription<
  TClient extends ZenQueryClient,
  TInput = unknown,
  // Constrain TOutput to object or array for Immer compatibility
  TOutput extends object | unknown[] = any,
  TError = Error,
  // Infer procedure type from selector
  TProcedure extends { subscribe: (input: TInput, callbacks: SubscriptionCallbacks<TOutput, TError>) => { unsubscribe: () => void } } = any
>(
  procedureSelector: ProcedureClientPathSelector<TClient, TProcedure>,
  options?: SubscriptionOptions<TInput, TOutput>
): SubscriptionAtom<TOutput, TError> {

  const { initialData, enabled = true, input } = options ?? {};
  const $procedureClientPath = computed(procedureSelector); // Error likely persists here

  // Determine stable key
  const { path: initialPath } = $procedureClientPath.get()!; // Error likely persists here
  const stableAtomKey = generateAtomKey(initialPath, input);

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

  const applyServerDelta = (coordinator: OptimisticSyncCoordinator, deltaPatches: readonly PatchOperation[]) => { // Use local PatchOperation
    if (!isMounted) return;
    try {
      const newState = applyJsonDelta(confirmedServerData, deltaPatches);
      confirmedServerData = newState;
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

  // --- Connection Logic ---

  const connectSubscription = () => {
    if (!isMounted || clientUnsubscribeFn || !enabled) return;

    const { client, procedure } = $procedureClientPath.get()!; // Error likely persists here
    const coordinator = client.getCoordinator();

    subscriptionMapAtom.setKey('status', 'connecting');
    subscriptionMapAtom.setKey('error', null);

    try {
      // Define callbacks for the client subscription
      const callbacks: SubscriptionCallbacks<TOutput, TError> = {
        onData: (data: TOutput | PatchOperation[]) => { // Use local PatchOperation
          if (!isMounted) return;
          // Basic check: Assume array is JSON Patch delta
          if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && 'op' in data[0] && 'path' in data[0]) {
             applyServerDelta(coordinator, data as PatchOperation[]); // Pass coordinator
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
          disconnectSubscription(); // Clean up on error
        },
        onComplete: () => {
          if (isMounted) {
            subscriptionMapAtom.setKey('status', 'closed');
          }
          disconnectSubscription(); // Clean up on completion
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

  const disconnectSubscription = () => {
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


  // --- Lifecycle ---
  onMount(subscriptionMapAtom, () => {
    isMounted = true;
    const { client } = $procedureClientPath.get()!; // Error likely persists here
    const coordinator = client.getCoordinator();

    registerAtom(stableAtomKey, subscriptionMapAtom);

    // Subscribe to coordinator events
    const unsubChange = coordinator.onStateChange(() => computeOptimisticState(coordinator));
    const unsubDelta = coordinator.onApplyDelta((delta: ServerDelta) => {
      if (delta.key === stableAtomKey) {
        applyServerDelta(coordinator, delta.patches);
      }
    });
    // Add explicit type for inversePatchesByAtom
    const unsubRollback = coordinator.onRollback((inversePatchesByAtom: Map<AtomKey, Patch[]>) => {
        const inversePatches = inversePatchesByAtom.get(stableAtomKey);
        if (inversePatches && inversePatches.length > 0) {
            console.warn(`[zenQuery][${stableAtomKey}] Rolling back optimistic updates due to mutation failure.`);
            try {
                const baseState = confirmedServerData ?? ({} as TOutput);
                confirmedServerData = applyImmerPatches(baseState as any, inversePatches as Patch[]);
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
    if (enabled) {
      connectSubscription();
    } else {
      subscriptionMapAtom.setKey('status', 'idle');
    }

    return () => { // Cleanup function
      isMounted = false;
      disconnectSubscription(); // Disconnect the actual subscription
      unregisterAtom(stableAtomKey);
      unsubscribeCoordinator?.();
      unsubscribeCoordinator = null;
    };
  });

  // --- Exposed Atom ---
  const finalAtom = subscriptionMapAtom as any; // Use 'any' temporarily
  finalAtom.key = stableAtomKey;
  // No reload function for subscriptions currently

  return finalAtom as SubscriptionAtom<TOutput, TError>; // Cast back
}