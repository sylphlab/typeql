import {
    Transport,
    RequestMessage,
    ResponseMessage,
    SubscribeMessage,
    UnsubscribeMessage,
    UpdateMessage,
    ClientUpdateMessage,
    ServerAckMessage,
    MissingUpdatesRequestMessage,
    ReqDeltaMessage,
} from '../core/types';
import { generateId } from '../core/utils';
import { createClientSequenceManager } from '../core/seqManager';
import { ConflictResolverConfig, resolveConflict } from './conflictResolver';

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
export interface OptimisticCreateStoreOptions<State, Delta, ReqP = any> {
    transport: Transport;
    topic: string;
    initialState: State; // Changed: Now required
    requestPayload?: ReqP;
    /** Applies a delta (client or server) to a given state. Must handle undefined state (e.g., during initial application or if confirmedState is undefined). */
    applyDelta: (state: State | undefined, delta: Delta) => State; // Input state can be undefined
    // revertDelta removed, rollback is handled by recalculating from confirmedState
    conflictConfig: ConflictResolverConfig<Delta>;
    generateRequestId?: () => string;
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
        topic,
        initialState, // Required
        requestPayload,
        applyDelta,
        conflictConfig,
        generateRequestId = generateId,
        cloneState = defaultCloneState,
        // optimisticTimeout // TODO: Implement timeout logic
    } = options;

    const clientSeqManager = createClientSequenceManager();
    // Initialize optimisticState with initialState, confirmedState might become undefined on error
    let state: OptimisticStoreState<State> = {
        confirmedState: initialState,
        optimisticState: initialState,
        isLoading: false,
        error: undefined,
        lastServerSeq: 0,
        isSyncing: false,
    };

    const pendingUpdates = new Map<number, PendingUpdate<State, Delta>>();
    const listeners = new Set<(state: Readonly<OptimisticStoreState<State>>) => void>();
    let cleanupTransport: (() => void) | void | undefined;
    let isConnected = true;

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
                computedOptimisticState = applyDelta(computedOptimisticState, pending.delta);
            }
        }
        // If confirmedState was undefined and no pending updates exist, this might still be undefined
        // But since initialState is required, confirmedState should only be undefined after a fetch error
        return computedOptimisticState;
    };

    // --- Message Handling ---

    const handleServerAck = (ack: ServerAckMessage) => {
        const pending = pendingUpdates.get(ack.clientSeq);
        if (!pending) {
            console.warn(`[ReqDelta Client] Received ack for unknown clientSeq: ${ack.clientSeq}`);
            return;
        }

        pendingUpdates.delete(ack.clientSeq);

        if (ack.success) {
            console.log(`[ReqDelta Client] Optimistic update ${ack.clientSeq} confirmed by server (serverSeq: ${ack.serverSeq}).`);
            // Ack success mainly cleans the queue. `handleServerUpdate` advances confirmed state.
        } else {
            console.warn(`[ReqDelta Client] Optimistic update ${ack.clientSeq} rejected by server: ${ack.conflictReason}`);
            // Failure: Rollback - recalculate optimistic state from confirmed + remaining pending
            const recalculatedOptimisticState = reapplyPendingUpdates();
            if(recalculatedOptimisticState !== undefined) {
                setState({
                    optimisticState: recalculatedOptimisticState,
                    error: new Error(`Optimistic update ${ack.clientSeq} rejected: ${ack.conflictReason}`),
                });
            } else {
                 console.error(`[ReqDelta Client] Rollback failed for rejected update ${ack.clientSeq}: Could not recalculate optimistic state.`);
                 setState({ error: new Error(`Rollback failed for rejected update ${ack.clientSeq}`) });
            }
        }
         // If queue is now empty, optimistic state should converge to confirmed state after rollback/ack processing
         if (pendingUpdates.size === 0 && state.confirmedState !== undefined) {
              const currentConfirmed = cloneState(state.confirmedState);
              if (currentConfirmed !== undefined && JSON.stringify(state.optimisticState) !== JSON.stringify(currentConfirmed)) {
                   // Avoid unnecessary updates if they already match
                   setState({ optimisticState: currentConfirmed });
              }
         }
    };

    const handleServerUpdate = (update: UpdateMessage<Delta>) => {
        console.log(`[ReqDelta Client] Received server update (serverSeq: ${update.serverSeq}).`);

        // --- Sequence Check ---
        const expectedNextSeq = state.lastServerSeq + 1;
        if (update.serverSeq !== undefined && state.lastServerSeq > 0 && update.serverSeq !== expectedNextSeq) {
            if (update.serverSeq < expectedNextSeq) {
                console.warn(`[ReqDelta Client] Received stale update ${update.serverSeq} (expected ${expectedNextSeq}). Ignoring.`);
                return;
            } else {
                console.warn(`[ReqDelta Client] Sequence gap detected! Expected ${expectedNextSeq}, got ${update.serverSeq}. Requesting missing.`);
                setState({ isSyncing: true });
                requestMissingUpdates(state.lastServerSeq, update.serverSeq);
                // TODO: Queue this update (update.serverSeq) to be processed after missing ones arrive.
                return;
            }
        }

        // --- Apply Update ---
        const newConfirmedState = applyDelta(state.confirmedState, update.delta);

        // --- Conflict Resolution / Rebase ---
        let newOptimisticState = newConfirmedState; // Start optimistic state from new confirmed state

        if (pendingUpdates.size > 0) {
            console.log(`[ReqDelta Client] Rebasing ${pendingUpdates.size} pending updates onto new confirmed state (serverSeq: ${update.serverSeq}).`);
            const sortedClientSeqs = [...pendingUpdates.keys()].sort((a, b) => a - b);
            let rebasedState: State | undefined = cloneState(newConfirmedState);

            for (const clientSeq of sortedClientSeqs) {
                const pending = pendingUpdates.get(clientSeq);
                if (pending) {
                    // TODO: Implement actual conflict resolution using resolveConflict function if needed.
                    rebasedState = applyDelta(rebasedState, pending.delta);
                }
            }
            // applyDelta should guarantee returning a defined State
             newOptimisticState = rebasedState!;
        }

        // --- Final State Update ---
        setState({
            confirmedState: newConfirmedState,
            optimisticState: newOptimisticState,
            lastServerSeq: update.serverSeq ?? state.lastServerSeq,
            isLoading: false,
            error: undefined,
            isSyncing: false,
        });
    };


    const handleIncomingMessage = (message: ReqDeltaMessage<any, ResP, Delta>) => {
        if (!isConnected || message.topic !== topic) return;

        switch (message.type) {
            case 'response':
                // This assumes the response payload IS the initial state
                if (message.error) {
                    console.error(`[ReqDelta Client] Error fetching initial state for topic "${topic}":`, message.error);
                    // Keep optimistic state as is, but mark error and stop loading
                    setState({ isLoading: false, error: message.error, confirmedState: undefined });
                } else {
                    console.log(`[ReqDelta Client] Received initial state for topic "${topic}".`);
                    pendingUpdates.clear(); // Clear pending updates on successful initial load/refresh
                    const initialStateData = message.payload as State; // Assuming payload is State
                    const clonedInitial = cloneState(initialStateData);

                    if (clonedInitial === undefined) {
                         // This is bad if cloneState failed for initial data
                         console.error(`[ReqDelta Client] Failed to clone initial state for topic "${topic}". Cannot initialize store correctly.`);
                         setState({
                              isLoading: false,
                              error: new Error("Failed to clone initial state"),
                              confirmedState: undefined,
                              // Keep optimisticState as the original required initialState? Or undefined? Let's keep initialState for safety.
                              // optimisticState: undefined
                         });
                    } else {
                         // Successfully cloned initial state
                         setState({
                              isLoading: false,
                              confirmedState: initialStateData, // Store the original received data
                              optimisticState: clonedInitial,    // Reset optimistic state to the cloned initial data
                              error: undefined,
                              lastServerSeq: 0, // Reset server sequence
                              isSyncing: false,
                         });
                    }
                }
                break;
            case 'update':
                handleServerUpdate(message as UpdateMessage<Delta>);
                break;
            case 'ack':
                handleServerAck(message as ServerAckMessage);
                break;
            case 'client_update':
            case 'missing_updates':
            case 'request':
            case 'subscribe':
            case 'unsubscribe':
                console.warn(`[ReqDelta Client] Received unexpected message type "${message.type}" from server. Ignoring.`);
                break;
            default:
                 console.warn(`[ReqDelta Client] Received unknown message type from server:`, message);
                break;
        }
    };

    // --- Outgoing Messages ---

    const sendMessage = async (message: ReqDeltaMessage) => {
       if (!isConnected) {
            console.warn(`[ReqDelta Client] Attempted to send message while disconnected:`, message);
            return;
        }
        try {
            await Promise.resolve(transport.sendMessage(message));
        } catch (err) {
            console.error(`[ReqDelta Client] Error sending message for topic "${topic}":`, err);
            setState({ error: new Error(`Failed to send message: ${err}`) });
        }
    };

     const requestInitialState = () => {
        pendingUpdates.clear(); // Clear pending on refresh
        setState({ isLoading: true, error: undefined, isSyncing: true });
        const requestId = generateRequestId();
        const requestMsg: RequestMessage<ReqP> = {
            type: 'request',
            id: requestId,
            topic: topic,
            ...(requestPayload !== undefined && { payload: requestPayload }),
        };
        sendMessage(requestMsg);
    };

    const subscribeToUpdates = () => {
        const subscribeId = generateRequestId();
        const subscribeMsg: SubscribeMessage = { type: 'subscribe', id: subscribeId, topic: topic };
        sendMessage(subscribeMsg);
    };

    const unsubscribeFromUpdates = () => {
        const unsubscribeId = generateRequestId();
        const unsubscribeMsg: UnsubscribeMessage = { type: 'unsubscribe', id: unsubscribeId, topic: topic };
         try {
             Promise.resolve(transport.sendMessage(unsubscribeMsg)).catch(err => {
                console.warn(`[ReqDelta Client] Error sending unsubscribe on disconnect:`, err);
             });
         } catch (err) {
             console.warn(`[ReqDelta Client] Error sending unsubscribe on disconnect:`, err);
         }
    };

     const requestMissingUpdates = (from: number, to: number) => {
        const requestMsg: MissingUpdatesRequestMessage = {
            type: 'missing_updates',
            topic: topic,
            fromSeq: from,
            toSeq: to,
        };
        sendMessage(requestMsg);
    };

    // --- Store API Implementation ---

    const applyOptimistic = (delta: Delta): number => {
        if (!isConnected) {
            console.error("[ReqDelta Client] Cannot apply optimistic update while disconnected.");
            return -1;
        }
        // Optimistic state should always be defined because initialState is required
        if (state.optimisticState === undefined) {
             console.error("[ReqDelta Client] Cannot apply optimistic update: optimisticState is unexpectedly undefined (this shouldn't happen).");
             return -1;
        }

        const clientSeq = clientSeqManager.getNext();
        const clonedSnapshot: State | undefined = cloneState(state.optimisticState);

        if (clonedSnapshot === undefined) {
             console.error("[ReqDelta Client] Failed to clone state for snapshot. Cannot apply optimistic update.");
             return -1; // Cloning failed
        }
        // Type safety: clonedSnapshot is now confirmed to be 'State'
        const snapshot: State = clonedSnapshot;

        // Apply optimistically
        // applyDelta receives the current optimistic state, which is guaranteed defined here
        const newOptimisticState: State = applyDelta(state.optimisticState, delta);

        // Store pending update - snapshot is now guaranteed to be State type
        const pending: PendingUpdate<State, Delta> = {
             delta,
             snapshot: snapshot, // Assign the guaranteed State value
             timestamp: Date.now()
        };
        pendingUpdates.set(clientSeq, pending);

        // Update local optimistic state immediately
        setState({ optimisticState: newOptimisticState, error: undefined });

        // Send to server
        const clientUpdateMsg: ClientUpdateMessage<Delta> = {
            type: 'client_update',
            topic: topic,
            clientSeq: clientSeq,
            delta: delta,
            timestamp: Date.now(),
        };
        sendMessage(clientUpdateMsg);

        return clientSeq;
    };

    // --- Initialization ---
    cleanupTransport = transport.onMessage(handleIncomingMessage);
    requestInitialState();
    subscribeToUpdates();
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
                 console.warn(`[ReqDelta Client] Cannot refresh disconnected store for topic "${topic}".`);
            }
        },
        disconnect: () => {
            if (!isConnected) return;
            isConnected = false;
            unsubscribeFromUpdates();
            if (typeof cleanupTransport === 'function') cleanupTransport();
            listeners.clear();
            pendingUpdates.clear();
            // Ensure optimisticState doesn't become undefined on disconnect unless confirmedState was already undefined
            const finalConfirmedState = state.confirmedState;
            setState({
                 isLoading: false,
                 error: new Error("Disconnected"),
                 optimisticState: finalConfirmedState === undefined ? state.optimisticState : finalConfirmedState
            });
             console.log(`[ReqDelta Client] Store disconnected for topic "${topic}".`);
        },
        applyOptimistic,
    };
}
