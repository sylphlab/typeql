import { map, onMount, task, type ReadableAtom, type Atom } from 'nanostores';
import type { Patch } from 'immer'; // Immer patches for optimistic updates
import { type Operation as PatchOperation } from 'fast-json-patch'; // JSON Patch for deltas

import type { ZenQueryClient } from '../client'; // Removed SubscriptionCallbacks import
import type { OptimisticSyncCoordinator, ServerDelta } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches } from './patchUtils'; // Use Immer utils
import { applyJsonDelta } from './stateUtils'; // Use JSON Patch delta applicator

// Define the shape of the state managed by the subscription map atom
export type SubscriptionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface SubscriptionAtomState<TData = unknown, TError = Error> {
  data: TData | undefined;
  status: SubscriptionStatus;
  error: TError | null;
  // Add other relevant state like lastUpdated, etc. if needed
}

// Define options for the subscription helper
export interface SubscriptionOptions<TInput = unknown, TData = unknown> {
  initialData?: TData; // Optional initial data before connection
  enabled?: boolean; // Default: true
  // Add other options like retry logic later
  input: TInput;
  // TODO: Define how procedure path is passed - likely via selector function
  path: string | string[]; // Or use a selector function approach
}

// Type for the selector function to get the client instance
type ClientGetter = <T extends ZenQueryClient>(clientAtom: Atom<T>) => T;

// Type for the returned atom, including potential actions
export interface SubscriptionAtom<TData = unknown, TError = Error> extends ReadableAtom<SubscriptionAtomState<TData, TError>> {
  // Add actions like reconnect later?
  key: AtomKey;
}

// Define the callback interface locally based on usage
interface SubscriptionCallbacks<TData = unknown, TError = Error> {
    onData: (data: TData | PatchOperation[]) => void;
    onError: (error: TError | Error | any) => void; // Allow generic Error or any
    onComplete: () => void;
    // onOpen?: () => void; // Optional
}


/**
 * Creates a Nanostore map atom to manage the state of a ZenQuery subscription.
 *
 * @param clientAtom The Nanostore atom holding the ZenQueryClient instance.
 * @param clientGetter A function to extract the client instance from the atom.
 * @param options Subscription configuration options including input and path/selector.
 * @returns A readable Nanostore map atom representing the subscription state.
 */
export function subscription<
  TClient extends ZenQueryClient,
  TInput = unknown,
  // Constrain TOutput to object or array for Immer compatibility
  TOutput extends object | unknown[] = any,
  TError = Error,
>(
  clientAtom: Atom<TClient>,
  clientGetter: ClientGetter,
  options: SubscriptionOptions<TInput, TOutput>
): SubscriptionAtom<TOutput, TError> {

  const { initialData, enabled = true, input, path } = options;
  const client = clientGetter(clientAtom);
  const coordinator = client.getCoordinator();

  const atomKey = generateAtomKey(path, input);

  // Use a map atom to hold the subscription state
  const subscriptionMapAtom = map<SubscriptionAtomState<TOutput, TError>>({
    data: initialData,
    status: 'idle',
    error: null,
  });

  // --- Internal State ---
  let isMounted = false;
  // Store the last known confirmed state from the server
  let confirmedServerData: TOutput | undefined = initialData;
  let unsubscribeCoordinator: (() => void) | null = null;
  let clientUnsubscribeFn: (() => void) | null = null; // Function to call client.unsubscribe

  // --- Logic Functions ---

  const computeOptimisticState = () => {
    if (!isMounted) return;

    const currentMapState = subscriptionMapAtom.get();
    const pendingPatchesMap = coordinator.getPendingPatches(); // Map<AtomKey, Patch[]> (Immer patches)
    const patchesForThisAtom = pendingPatchesMap.get(atomKey) || [];

    let optimisticData: TOutput | undefined;
    let computationError: Error | null = null;

    if (patchesForThisAtom.length === 0) {
      optimisticData = confirmedServerData;
    } else {
      try {
        const baseState = confirmedServerData ?? ({} as TOutput);
        // Cast baseState to 'any' to satisfy Immer's applyPatches
        optimisticData = applyImmerPatches(baseState as any, patchesForThisAtom);
      } catch (error) {
        console.error(`[zenQuery][${atomKey}] Failed to apply optimistic patches:`, error);
        computationError = error instanceof Error ? error : new Error('Failed to compute optimistic state');
        optimisticData = confirmedServerData; // Fallback
      }
    }

    // Update the 'data' field in the map atom
    if (currentMapState.data !== optimisticData || currentMapState.error !== computationError) {
        subscriptionMapAtom.setKey('data', optimisticData);
        if (computationError && !currentMapState.error) {
            subscriptionMapAtom.setKey('error', computationError as TError);
            subscriptionMapAtom.setKey('status', 'error');
        } else if (!computationError && currentMapState.error) {
            subscriptionMapAtom.setKey('error', null);
            // Don't reset status here, let connect/delta handlers manage status
        }
    }
  };

  // Apply JSON patches received from the server delta via coordinator OR direct subscription
  const applyServerDelta = (deltaPatches: readonly PatchOperation[]) => {
    if (!isMounted) return;
    try {
      const newState = applyJsonDelta(confirmedServerData, deltaPatches);
      confirmedServerData = newState;
      computeOptimisticState(); // Recompute optimistic state
    } catch (error) {
      console.error(`[zenQuery][${atomKey}] Failed to apply server delta:`, error);
      subscriptionMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Failed to apply server delta') as TError);
      subscriptionMapAtom.setKey('status', 'error');
    }
  };

  // Handle full snapshot updates from the subscription
  const applyServerSnapshot = (snapshotData: TOutput) => {
      if (!isMounted) return;
      confirmedServerData = snapshotData;
      computeOptimisticState(); // Recompute optimistic state after snapshot
  };

  // --- Connection Logic ---

  const connectSubscription = () => {
    if (!isMounted || clientUnsubscribeFn || !enabled) return; // Don't connect if unmounted, already connected, or disabled

    subscriptionMapAtom.setKey('status', 'connecting');
    subscriptionMapAtom.setKey('error', null);

    try {
      const normalizedPath = Array.isArray(path) ? path.join('.') : path;
      const procedure = (client.subscription as any)[normalizedPath];

      if (typeof procedure?.subscribe !== 'function') {
        throw new Error(`[zenQuery] Procedure 'subscription.${normalizedPath}' not found or is not a subscribe function.`);
      }

      // Define callbacks for the client subscription using the local interface
      const callbacks: SubscriptionCallbacks<TOutput, TError> = {
        // Add explicit type for data parameter
        onData: (data: TOutput | PatchOperation[]) => {
          if (!isMounted) return;
          // Assume server sends metadata to distinguish snapshot vs delta, or infer based on type
          // For now: basic check: Assume array is JSON Patch delta
          if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && 'op' in data[0] && 'path' in data[0]) {
             applyServerDelta(data as PatchOperation[]);
          } else { // Assume full snapshot
             applyServerSnapshot(data as TOutput);
          }
          // Update status if needed
          if (subscriptionMapAtom.get().status === 'connecting') {
              subscriptionMapAtom.setKey('status', 'connected');
          }
        },
        // Add explicit type for error parameter
        onError: (error: TError | Error | any) => {
          console.error(`[zenQuery][${atomKey}] Subscription error:`, error);
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
        // onOpen: () => { // Optional: handle open event if provided by transport
        //     if (isMounted) {
        //         subscriptionMapAtom.setKey('status', 'connected');
        //     }
        // }
      };

      const { unsubscribe } = procedure.subscribe(input, callbacks);
      clientUnsubscribeFn = unsubscribe; // Store the unsubscribe function

      // Optimistically set to connected, callbacks will handle errors/data
      if (subscriptionMapAtom.get().status === 'connecting') {
          subscriptionMapAtom.setKey('status', 'connected');
      }

    } catch (error) {
      console.error(`[zenQuery][${atomKey}] Failed to initiate subscription:`, error);
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
        console.error(`[zenQuery][${atomKey}] Error during unsubscribe:`, error);
      }
      clientUnsubscribeFn = null;
      // Don't reset data, keep last known state
      if (isMounted && subscriptionMapAtom.get().status !== 'error') {
          subscriptionMapAtom.setKey('status', 'closed');
      }
    }
  };


  // --- Lifecycle ---
  onMount(subscriptionMapAtom, () => {
    isMounted = true;
    registerAtom(atomKey, subscriptionMapAtom); // Register the main map atom

    // Subscribe to coordinator events
    const unsubChange = coordinator.onStateChange(computeOptimisticState);
    // Apply deltas coming from *other* mutations via the coordinator
    const unsubDelta = coordinator.onApplyDelta((delta: ServerDelta) => {
      if (delta.key === atomKey) {
        // This handles deltas pushed via the coordinator (e.g., after conflict resolution)
        applyServerDelta(delta.patches);
      }
    });
    // Handle rollbacks affecting this subscription's data
    const unsubRollback = coordinator.onRollback((inversePatchesByAtom) => {
        const inversePatches = inversePatchesByAtom.get(atomKey);
        if (inversePatches && inversePatches.length > 0) {
            console.warn(`[zenQuery][${atomKey}] Rolling back optimistic updates due to mutation failure.`);
            try {
                // Apply inverse Immer patches
                const baseState = confirmedServerData ?? ({} as TOutput);
                // Cast needed for applyImmerPatches
                confirmedServerData = applyImmerPatches(baseState as any, inversePatches as Patch[]);
                computeOptimisticState(); // Recompute state after rollback
            } catch (error) {
                console.error(`[zenQuery][${atomKey}] Error applying rollback patches:`, error);
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
      unregisterAtom(atomKey);
      unsubscribeCoordinator?.();
      unsubscribeCoordinator = null;
    };
  });

  // TODO: Handle changes in 'enabled' option reactively

  // --- Exposed Atom ---
  const exposedAtom = {
    ...subscriptionMapAtom,
    key: atomKey,
  };

  return exposedAtom as SubscriptionAtom<TOutput, TError>;
}