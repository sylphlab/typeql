// NOTE: This entire store implementation is heavily based on the OLD ReqDelta message
// structure (topics, specific delta/ack messages, sequence numbers).
// It needs SIGNIFICANT REFACTORING to work correctly with the new TypeQL message
// structure (paths, request/result messages, subscription lifecycle messages)
// and the transport interface (`request`, `subscribe`).
// The changes below are minimal fixes for type errors and placeholders.

import type {
    TypeQLTransport,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage, // Keep this for initiating
    UnsubscribeMessage, // Keep this for stopping
    SubscriptionDataMessage, // For receiving data
    SubscriptionHandlers, // Needed for subscribe call
    SubscriptionErrorMessage, // For receiving errors
    SubscriptionEndMessage, // For receiving end signal
    // Old message types are no longer valid here:
    // Transport, RequestMessage, ResponseMessage, UpdateMessage, ClientUpdateMessage, ServerAckMessage, MissingUpdatesRequestMessage, ReqDeltaMessage
} from '../core/types';
import { generateId } from '../core/utils'; // Keep for request IDs?
// import { createClientSequenceManager } from '../core/seqManager'; // Sequence logic needs rework
import type { ConflictResolverConfig } from './conflictResolver'; // Keep config type, but logic needs rework
// import { resolveConflict } from './conflictResolver'; // Logic needs rework

// --- Types ---

/** Represents an update waiting for server acknowledgement. */
interface PendingUpdate<State, Delta> {
    delta: Delta;
    /** State snapshot *before* this delta was applied optimistically. */
    snapshot: State; // Should always be defined because initialState is required
    timestamp: number;
    // Optional: timer for timeout/retry?
}

/** State managed by the Optimistic Store. */
export interface OptimisticStoreState<State> {
    /** The last state confirmed by the server. */
    confirmedState: State | undefined; // Can be undefined before first response
    /** The current state including optimistic updates, shown to the UI. */
    optimisticState: State; // Should always be defined after init
    /** Indicates if the initial state is currently being loaded. */
    isLoading: boolean;
    /** Stores any error that occurred. */
    error: string | Error | undefined;
    /** The last server sequence number processed successfully. */
    lastServerSeq: number;
     /** Indicates if the store is currently out of sync and needs recovery. */
    isSyncing: boolean;
}

/** Options for creating an OptimisticReqDeltaStore. */
// TODO: Rework Delta/ReqP/ResP generics to align with procedure types.
export interface OptimisticCreateStoreOptions<State, Delta, ReqP = any> {
    transport: TypeQLTransport; // Use new transport type
    // topic: string; // Topics replaced by paths - Need path for subscription/query
    path: string; // Path to the specific procedure (e.g., for the subscription this store manages)
    initialState: State; // Changed: Now required
    // requestPayload?: ReqP; // Input payload is part of applyOptimistic or refresh
    /** Placeholder: Applies data/delta to state. Needs context if delta vs full state. */
    applyUpdate: (state: State | undefined, data: Delta /* or State? */) => State; // Input state can be undefined
    // revertDelta removed, rollback is handled by recalculating from confirmedState
    conflictConfig: ConflictResolverConfig<unknown>; // Conflict resolution needs rework for TypeQL model
    generateRequestId?: () => string | number; // TypeQL uses string | number IDs
    /** Optional: Function to deep clone state for snapshots. Defaults to structuredClone if available. */
    cloneState?: (state: State | undefined) => State | undefined;
    /** Optional: Timeout in ms for optimistic updates before considering them failed. */
    optimisticTimeout?: number;
}

/** Public API of the OptimisticReqDeltaStore. */
export interface OptimisticReqDeltaStore<State, Delta> {
    getState: () => Readonly<OptimisticStoreState<State>>;
    subscribe: (listener: (state: Readonly<OptimisticStoreState<State>>) => void) => () => void;
    refresh: () => void;
    disconnect: () => void;
    /** Applies an optimistic update locally and sends it to the server. */
    applyOptimistic: (delta: Delta) => number; // Returns the clientSeq
}

// --- Implementation ---

const defaultCloneState = <State>(state: State | undefined): State | undefined => {
    if (typeof structuredClone === 'function') {
        return structuredClone(state);
    } else {
        // Basic fallback - WARNING: Doesn't handle Date, RegExp, functions, etc.
        console.warn("[ReqDelta Client] structuredClone not available. Using basic JSON clone (may lose data types). Consider providing a 'cloneState' function.");
        return state === undefined ? undefined : JSON.parse(JSON.stringify(state));
    }
};

/**
 * Creates a ReqDelta client store with support for optimistic updates.
 */
export function createOptimisticStore<State, Delta, ReqP = any, ResP = any>(
    options: OptimisticCreateStoreOptions<State, Delta, ReqP>
): OptimisticReqDeltaStore<State, Delta> {
    const {
        transport,
        path, // Use path instead of topic
        initialState, // Required
        applyUpdate, // Use applyUpdate instead of applyDelta
        conflictConfig,
        generateRequestId = generateId,
        cloneState = defaultCloneState,
        // optimisticTimeout // TODO: Implement timeout logic
    } = options;

    // TODO: Rework sequence management for TypeQL if needed (likely server-driven for subscriptions)
    // const clientSeqManager = createClientSequenceManager();
    let clientSeqCounter = 0; // Temporary simple counter

    // Initialize optimisticState with initialState, confirmedState might become undefined on error
    let state: OptimisticStoreState<State> = {
        confirmedState: initialState, // Start confirmed state with initial state
        optimisticState: initialState,
        isLoading: false, // Initial state is provided, not loading initially unless refreshed
        error: undefined,
        lastServerSeq: 0, // Sequence management needs rework for TypeQL
        isSyncing: false,
    };

    const pendingUpdates = new Map<number, PendingUpdate<State, Delta>>(); // Pending updates map needs rework
    const listeners = new Set<(state: Readonly<OptimisticStoreState<State>>) => void>();
    let unsubscribeFn: (() => void) | undefined; // Store the unsubscribe function from transport.subscribe
    let isConnected = true; // TODO: Hook into transport.onConnectionChange if available

    // --- State Management ---

    const setState = (newState: Partial<OptimisticStoreState<State>>) => {
        // Ensure optimisticState never becomes undefined after initialization unless explicitly set by error
        const nextState = { ...state, ...newState };
        if (newState.optimisticState === undefined && state.optimisticState !== undefined && !newState.error) {
             console.warn("[ReqDelta Client] Attempted to set optimisticState to undefined without an error. Retaining previous state.");
             nextState.optimisticState = state.optimisticState; // Prevent accidental undefined state
        }
        state = nextState;
        listeners.forEach(listener => listener(Object.freeze({ ...state })));
    };

    // Recalculates optimisticState based on confirmedState and pending updates
    const reapplyPendingUpdates = (): State | undefined => {
        let computedOptimisticState = cloneState(state.confirmedState);
        const sortedClientSeqs = [...pendingUpdates.keys()].sort((a, b) => a - b);
        for (const clientSeq of sortedClientSeqs) {
            const pending = pendingUpdates.get(clientSeq);
            if (pending) {
                // TODO: Rework reapplyPendingUpdates using applyUpdate
                // computedOptimisticState = applyUpdate(computedOptimisticState, pending.delta);
                 console.warn("OptimisticStore: reapplyPendingUpdates needs rework with applyUpdate");
            }
        }
        // If confirmedState was undefined and no pending updates exist, this might still be undefined
        // But since initialState is required, confirmedState should only be undefined after a fetch error
        return computedOptimisticState;
    };

    // --- Message Handling (Needs Complete Rework for TypeQL) ---

    // TODO: Implement handleServerAck equivalent if needed for optimistic mutations in TypeQL
    // This likely involves inspecting mutation results or specific subscription messages.
    // const handleServerAck = (ack: ServerAckMessage) => { ... };

    // TODO: Rework handleServerUpdate for SubscriptionDataMessage
    const handleSubscriptionData = (dataMessage: SubscriptionDataMessage) => {
        const data = dataMessage.data as Delta; // Assuming data is Delta for now
        const serverSeq = dataMessage.seq;
        console.log(`[TypeQL OptimisticStore] Received subscription data (seq: ${serverSeq}).`);

        // --- Sequence Check (Needs Rework) ---
        // Sequence logic needs to be adapted based on how TypeQL handles subscription streams and potential gaps.
        // Commenting out old logic for now.
        /*
        const expectedNextSeq = state.lastServerSeq + 1;
        if (serverSeq !== undefined && state.lastServerSeq > 0 && serverSeq !== expectedNextSeq) {
            if (serverSeq < expectedNextSeq) {
                console.warn(`[TypeQL OptimisticStore] Received stale update ${serverSeq} (expected ${expectedNextSeq}). Ignoring.`);
                return;
            } else {
                console.warn(`[TypeQL OptimisticStore] Sequence gap detected! Expected ${expectedNextSeq}, got ${serverSeq}. Requesting missing.`);
                setState({ isSyncing: true });
                // requestMissingUpdates(state.lastServerSeq, serverSeq); // requestMissingUpdates needs rework
                return;
            }
        }
        */

        // --- Apply Update ---
        const newConfirmedState = applyUpdate(state.confirmedState, data);

        // --- Conflict Resolution / Rebase (Needs Rework) ---
        let newOptimisticState = newConfirmedState;
        if (pendingUpdates.size > 0) {
            console.log(`[TypeQL OptimisticStore] Rebasing ${pendingUpdates.size} pending updates onto new confirmed state (seq: ${serverSeq}).`);
            // Rebase logic needs complete rework based on applyUpdate and conflictConfig
            const rebasedState = reapplyPendingUpdates(); // reapplyPendingUpdates itself needs rework
            if (rebasedState !== undefined) {
                newOptimisticState = rebasedState;
            } else {
                console.error("[TypeQL OptimisticStore] Rebase failed, could not recalculate optimistic state.");
                // Decide how to handle rebase failure - maybe fallback to confirmed state?
                newOptimisticState = newConfirmedState;
            }
        }

        // --- Final State Update ---
        setState({
            confirmedState: newConfirmedState,
            optimisticState: newOptimisticState,
            lastServerSeq: serverSeq ?? state.lastServerSeq, // Rework needed
            isLoading: false,
            error: undefined,
            isSyncing: false, // Rework needed
        });
    };

     const handleSubscriptionError = (error: SubscriptionErrorMessage['error']) => {
          console.error(`[TypeQL OptimisticStore] Subscription error for path "${path}":`, error.message);
          setState({ isLoading: false, error: error.message || 'Subscription error' });
     };

     const handleSubscriptionEnd = () => {
          console.log(`[TypeQL OptimisticStore] Subscription ended normally for path "${path}".`);
          // Optionally reset state or mark as disconnected? Depends on desired behavior.
          // Maybe just clear loading/error flags.
          setState({ isLoading: false, error: undefined });
          unsubscribeFn = undefined; // Clear unsubscribe function
     };

    // --- Outgoing Messages ---

    // TODO: Rework sendMessage to use transport.request/transport.subscribe
    // const sendMessage = async (message: /* TypeQL Message Type */) => { ... };

    // TODO: Rework requestInitialState to use transport.request (likely a query)
     const requestInitialState = async () => {
        // pendingUpdates.clear(); // Clear pending on refresh? Depends on optimistic strategy.
        setState({ isLoading: true, error: undefined /*, isSyncing: true? */ });
        const requestId = generateRequestId();
        const queryMessage: ProcedureCallMessage = {
            type: 'query', // Assuming initial state is fetched via a query
            id: requestId,
            path: path, // Use the store's configured path
            input: undefined, // Assuming no input needed for initial fetch, or needs parameter
        };
        try {
            const resultMessage = await transport.request(queryMessage);
            if (resultMessage.result.type === 'data') {
                 console.log(`[TypeQL OptimisticStore] Received initial state for path "${path}".`);
                 pendingUpdates.clear(); // Clear pending on successful refresh
                 const initialStateData = resultMessage.result.data as State; // Assuming result is State
                 const clonedInitial = cloneState(initialStateData);
                 if (clonedInitial === undefined) {
                     throw new Error("Failed to clone initial state");
                 }
                 setState({
                      isLoading: false,
                      confirmedState: initialStateData,
                      optimisticState: clonedInitial,
                      error: undefined,
                      lastServerSeq: 0, // Reset sequence
                      isSyncing: false,
                 });

            } else {
                 // Error result
                 throw new Error(resultMessage.result.error.message || 'Failed to fetch initial state');
            }
        } catch (err: any) {
            console.error(`[TypeQL OptimisticStore] Error fetching initial state for path "${path}":`, err);
            setState({ isLoading: false, error: err.message || err, confirmedState: undefined }); // Set confirmed to undefined on error
        }
    };

    // Subscribe using the new transport interface
    const subscribeToUpdates = () => {
        if (unsubscribeFn) {
             console.warn(`[TypeQL OptimisticStore] Already subscribed to path "${path}". Skipping.`);
             return; // Already subscribed
        }
        console.log(`[TypeQL OptimisticStore] Subscribing to path "${path}"...`);
        const subscribeId = generateRequestId();
        const subscribeMsg: SubscribeMessage = { type: 'subscription', id: subscribeId, path: path /* input: ??? */ };

        const handlers: SubscriptionHandlers = {
            onData: handleSubscriptionData,
            onError: handleSubscriptionError,
            onEnd: handleSubscriptionEnd,
        };

        try {
             unsubscribeFn = transport.subscribe(subscribeMsg, handlers);
        } catch (err: any) {
             console.error(`[TypeQL OptimisticStore] Error initiating subscription for path "${path}":`, err);
             setState({ isLoading: false, error: err.message || err });
        }
    };

    // Unsubscribe using the stored function from transport.subscribe
    const unsubscribeFromUpdates = () => {
         if (unsubscribeFn) {
             console.log(`[TypeQL OptimisticStore] Unsubscribing from path "${path}"...`);
             try {
                  unsubscribeFn();
             } catch (err) {
                  console.warn(`[TypeQL OptimisticStore] Error during unsubscribe call:`, err);
             }
             unsubscribeFn = undefined;
         }
    };

    // TODO: Rework requestMissingUpdates - how does TypeQL handle this? Maybe not needed?
    // const requestMissingUpdates = (from: number, to: number) => { ... };

    // --- Store API Implementation (Needs Rework for Optimistic Updates) ---

    // TODO: Rework applyOptimistic for TypeQL mutation model
    const applyOptimistic = (delta: Delta): number => {
         if (!isConnected) {
             console.error("[TypeQL OptimisticStore] Cannot apply optimistic update while disconnected.");
             return -1;
         }
         if (state.optimisticState === undefined) {
              console.error("[TypeQL OptimisticStore] Cannot apply optimistic update: optimisticState is unexpectedly undefined.");
              return -1;
         }

         const clientSeq = ++clientSeqCounter; // Use temporary counter
         const clonedSnapshot = cloneState(state.optimisticState);

         if (clonedSnapshot === undefined) {
              console.error("[TypeQL OptimisticStore] Failed to clone state for snapshot. Cannot apply optimistic update.");
              return -1;
         }
         const snapshot: State = clonedSnapshot;

         // Apply optimistically using applyUpdate
         const newOptimisticState = applyUpdate(state.optimisticState, delta);

         // Store pending update (structure might need change)
         const pending: PendingUpdate<State, Delta> = { delta, snapshot, timestamp: Date.now() };
         pendingUpdates.set(clientSeq, pending);

         // Update local state
         setState({ optimisticState: newOptimisticState, error: undefined });

         // TODO: Send mutation to server using transport.request
         // Need to know the mutation path and structure the input correctly.
         // This delta likely needs to map to a specific mutation procedure's input.
         console.warn("[TypeQL OptimisticStore] applyOptimistic needs rework to send mutation via transport.request.");
         /*
         const mutationMsg: ProcedureCallMessage = {
             type: 'mutation',
             id: generateRequestId(),
             path: ???, // Path to the mutation procedure
             input: ???, // Input derived from delta
         };
         transport.request(mutationMsg).then(handleMutationResult).catch(handleMutationError);
         */

         return clientSeq; // Return temporary client sequence
    };

    // --- Initialization ---
    // Use transport.subscribe which returns unsubscribe function
    // No need for onMessage handler anymore.
    // cleanupTransport = transport.onMessage(handleIncomingMessage); // Remove old handler attachment
    requestInitialState(); // Fetch initial state via query
    subscribeToUpdates(); // Subscribe using the new transport method
    // --- End Initialization ---

    return {
        getState: () => Object.freeze({ ...state }),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refresh: () => {
            if (isConnected) {
                requestInitialState();
            } else {
                 console.warn(`[TypeQL OptimisticStore] Cannot refresh disconnected store for path "${path}".`);
            }
        },
        disconnect: () => {
            if (!isConnected) return;
            isConnected = false;
            unsubscribeFromUpdates(); // Use the new unsubscribe method
            // if (typeof cleanupTransport === 'function') cleanupTransport(); // Remove old handler cleanup
            listeners.clear();
            pendingUpdates.clear(); // Clear pending updates on disconnect
            // Ensure optimisticState doesn't become undefined on disconnect unless confirmedState was already undefined
            const finalConfirmedState = state.confirmedState;
            setState({
                 isLoading: false,
                 error: new Error("Disconnected"),
                 // Fallback optimistic state to confirmed state on disconnect
                 optimisticState: finalConfirmedState === undefined ? initialState : finalConfirmedState // Use initialState if confirmed is undefined
            });
             console.log(`[TypeQL OptimisticStore] Store disconnected for path "${path}".`);
        },
        applyOptimistic, // Keep API, implementation needs rework
    };
}
