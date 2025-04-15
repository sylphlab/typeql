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
    StandardDelta,
    StandardOperation
} from '../core/types';
import {
    generateId,
    applyStandardDelta, // Default applicator
    standardOperationToDelta, // Default converter
    standardMatchesPendingOperation, // Default matcher
    defaultCloneState as cloneStateUtil // Use alias
} from '../core/utils';
import { createClientSequenceManager } from '../core/seqManager';
import type { ConflictResolverConfig } from './conflictResolver';
// TODO: Import actual resolveConflict logic when implemented
// import { resolveConflict } from './conflictResolver';

// Define type locally based on factory return type
type ClientSequenceManager = ReturnType<typeof createClientSequenceManager>;


// --- Types ---

/** Represents an update waiting for server acknowledgement. */
interface PendingUpdate<State, Delta, Operation> {
    operation: Operation; // Store the original operation
    delta: Delta; // The delta generated from the operation
    /** State snapshot *before* this delta was applied optimistically. */
    snapshot: State;
    timestamp: number;
    clientSeq: number;
    // Optional: timer for timeout/retry?
}

/** State managed by the Store. Includes optimistic state if enabled. */
export interface StoreState<State> {
    /** The last state confirmed by the server. Undefined before first response or after error. */
    confirmedState: State | undefined;
    /** The current state including optimistic updates (if enabled), shown to the UI. */
    optimisticState: State; // Always defined after init because initialState is required
    /** Indicates if the initial state is currently being loaded. */
    isLoading: boolean;
    /** Stores any error that occurred. */
    error: string | Error | undefined;
    /** The last server sequence number processed successfully. */
    lastServerSeq: number;
    /** Indicates if the store is currently out of sync and needs recovery. */
    isSyncing: boolean;
    /** Is the transport currently considered connected? */
    isConnected: boolean;
    /** Target server sequence number during sync recovery. -1 if not syncing. */
    syncTargetSeq: number;
}

/** Options for creating a ReqDeltaStore. */
export interface CreateStoreOptions<
    State,
    // Add Item generic, default to 'any' for cases where standard handlers aren't used
    Item extends { id: string } = any,
    Delta = StandardDelta<Item, State>, // Use Item generic
    Operation = StandardOperation<Item>, // Use Item generic
    ReqP = any,
    ResP = any // Added ResP for type safety
> {
    /** The transport adapter instance. */
    transport: Transport;
    /** The topic to subscribe to. */
    topic: string;
    /** Initial state. Required. */
    initialState: State;
    /** Optional payload for the initial request. */
    requestPayload?: ReqP;

    /**
     * Function to apply incoming deltas (server or optimistic) to the current state.
     * Must return the new state. Defaults to `applyStandardDelta`.
     * @param currentState The current state (can be undefined during initial phases).
      * @param delta The incoming delta.
      * @returns The new state after applying the delta. MUST NOT return undefined unless the intention is to represent an error state or clear the state entirely.
      */
     applyDelta?: (currentState: State | undefined, delta: Delta) => State;

     // --- Optimistic Update Options (Optional) ---
    /**
     * If provided, enables optimistic updates. Converts a client operation into a delta.
     * Defaults to `standardOperationToDelta` if Delta/Operation are standard.
     * Return null to prevent an operation from being processed optimistically or sent.
     */
    operationToDelta?: (operation: Operation, currentState: State) => Delta | null;
    /**
     * If provided alongside `operationToDelta`, used to match incoming server deltas to pending operations.
     * Defaults to `standardMatchesPendingOperation` if Delta/Operation are standard.
     */
    matchesPendingOperation?: (delta: Delta, operation: Operation) => boolean;
    /** Configuration for conflict resolution. Required if optimistic updates are enabled. */
    conflictConfig?: ConflictResolverConfig<Delta>; // Takes Delta type

    // --- Other Options ---
    /** Optional function to generate unique request/message IDs. Defaults to a simple generator. */
    generateRequestId?: () => string;
    /** Optional function to deep clone state for snapshots. Defaults to structuredClone or JSON fallback. */
    cloneState?: (state: State | undefined) => State | undefined;
    /** Optional: Timeout in ms for optimistic updates before considering them failed. TODO */
    optimisticTimeout?: number;
    /** Optional: Define path for standard delta application if state is complex. */
    collectionPath?: string[];
    /** Optional: Callback for connection status changes. */
    onConnectionChange?: (isConnected: boolean) => void;
}

/** Public API of the ReqDeltaStore. */
export interface ReqDeltaStore<State, Operation = any> {
    /** Get the current state of the store (including optimistic state). */
    getState: () => Readonly<StoreState<State>>;
    /**
     * Subscribe to state changes.
     * @param listener The callback function to invoke when the state changes.
     * @returns A function to unsubscribe the listener.
     */
    subscribe: (listener: (state: Readonly<StoreState<State>>) => void) => () => void;
    /** Force a refresh by re-requesting the initial state. Clears pending optimistic updates. */
    refresh: () => void;
    /** Disconnect the store and clean up resources (e.g., unsubscribe). */
    disconnect: () => void;
    /**
     * Perform an operation. If optimistic updates are enabled, applies locally and sends to server.
     * @param operation The operation to perform.
     * @returns The client sequence number if sent optimistically, or -1 otherwise.
     */
    performOperation: (operation: Operation) => number;
}


/**
 * Creates a ReqDelta client store for managing state synchronized with a server topic.
 * Supports optional optimistic updates.
 *
 * @template State The type of the application state managed by the store.
 * @template Item The type of items used in standard collection operations.
 * @template Delta The type of the delta messages used for updates. Defaults to StandardDelta<Item, State>.
 * @template Operation The type of the client operations used for performing actions. Defaults to StandardOperation<Item>.
 * @template ReqP The type of the payload for the initial state request.
 * @template ResP The type of the payload in the server's response message.
 *
 * @param options Configuration options for the store.
 * @returns A ReqDeltaStore instance.
 */
export function createStore<
    State,
    // Add Item generic here for defaults
    Item extends { id: string } = any, // Keep Item generic here
    Delta = StandardDelta<Item, State>,
    Operation = StandardOperation<Item>,
    ReqP = any,
    ResP = any
>(
    // Ensure options uses the Item generic correctly.
    options: CreateStoreOptions<State, Item, Delta, Operation, ReqP, ResP>
): ReqDeltaStore<State, Operation> {
    const {
        transport,
        topic,
        initialState, // Required
        requestPayload,
        // --- Delta Application ---
        applyDelta: userApplyDelta,
        collectionPath, // Used by default applyStandardDelta
        // --- Optimistic Config ---
        operationToDelta: userOperationToDelta,
        matchesPendingOperation: userMatchesPendingOperation,
        conflictConfig, // Required for optimistic updates
        // --- Utils ---
        generateRequestId = generateId,
        cloneState = cloneStateUtil, // Use the imported aliased function
        onConnectionChange: userOnConnectionChange,
        // optimisticTimeout // TODO
    } = options;

    // Determine if optimistic updates are enabled
    const optimisticEnabled = !!userOperationToDelta;
    if (optimisticEnabled && !conflictConfig) {
        // Make it an error instead of a warning? For now, warn.
        console.warn(`[ReqDelta] Optimistic updates enabled ('operationToDelta' provided) but 'conflictConfig' is missing. Conflicts may not be handled correctly.`);
    }

    // --- Setup Default Functions ---
     const applyDelta = userApplyDelta ?? ((currentState: State | undefined, delta: Delta): State => {
         // Default logic assumes Delta is compatible with StandardDelta<Item, State>
         const pathAwareDelta = {
             ...(delta as any), // Cast needed as Delta might not be StandardDelta
             path: (delta as any).path ?? collectionPath ?? [],
         };
         const standardDelta = pathAwareDelta as StandardDelta<Item, State>; // Use Item generic here

         // Handle undefined currentState for default applicator
         if (currentState === undefined) {
             if (standardDelta.type === 'replace') {
                 return standardDelta.state;
             }
             if (standardDelta.type === 'add' && (standardDelta.path ?? []).length === 0) {
                 // This assumption is weak, but necessary for a default. User should override if state isn't Item[].
                 return [standardDelta.item] as unknown as State;
             }
             console.warn(`[ReqDelta] Default applyDelta cannot apply delta type "${standardDelta.type}" to undefined state. Returning initial state.`);
             return initialState;
         }

         // Apply using the standard function if currentState is defined
         // Ensure Item generic is correctly passed to applyStandardDelta
         return applyStandardDelta<State, Item>(currentState, standardDelta);
    });

    const operationToDelta = userOperationToDelta ?? (optimisticEnabled
        // Pass Item generic to standardOperationToDelta. It only takes the operation.
        ? (op: Operation, _currentState: State) => standardOperationToDelta<Item, State>(op as StandardOperation<Item>) as Delta | null
        : undefined);

    const matchesPendingOperation = userMatchesPendingOperation ?? (optimisticEnabled
        // Pass Item generic to standardMatchesPendingOperation
        ? (delta: Delta, op: Operation) => standardMatchesPendingOperation<Item, State>(delta as StandardDelta<Item, State>, op as StandardOperation<Item>)
        : undefined);

    // --- Internal State ---
    const clientSeqManager: ClientSequenceManager | null = optimisticEnabled ? createClientSequenceManager() : null;
    let internalState: StoreState<State> = {
        confirmedState: initialState,
        optimisticState: initialState,
        isLoading: false,
        error: undefined,
        lastServerSeq: 0,
        isSyncing: false,
        isConnected: transport.connected ?? true,
        syncTargetSeq: -1, // Initialize syncTargetSeq
    };

    const pendingUpdates = new Map<number, PendingUpdate<State, Delta, Operation>>();
    const listeners = new Set<(state: Readonly<StoreState<State>>) => void>();
    let cleanupTransportOnMessage: (() => void) | void | undefined;
    let cleanupTransportOnConnection: (() => void) | void | undefined;
    let isStoreConnected = true;
    // Queue for updates received while syncing missing ones
    let syncQueue: UpdateMessage<Delta>[] = [];
    // Track the target sequence number during sync recovery
    let syncTargetSeq = -1;

    // --- State Management ---

    const setState = (newState: Partial<StoreState<State>>) => {
        const nextState = { ...internalState, ...newState };
        if (newState.optimisticState === undefined && internalState.optimisticState !== undefined && !newState.error) {
             console.warn("[ReqDelta Client] Attempted to set optimisticState to undefined without an error. Retaining previous state.");
             nextState.optimisticState = internalState.optimisticState;
        }
        nextState.isConnected = internalState.isConnected;

        internalState = nextState;
        listeners.forEach(listener => listener(Object.freeze({ ...internalState })));
    };

    const updateConnectionStatus = (newTransportConnected: boolean) => {
        // Use isStoreConnected flag to prevent updates after explicit disconnect()
        if (!isStoreConnected) return;
        if (internalState.isConnected !== newTransportConnected) {
             // Update internal state, which will then be passed to setState
            internalState.isConnected = newTransportConnected; // Update the tracked connection status
            setState({ isConnected: newTransportConnected }); // Notify listeners
             if (userOnConnectionChange) {
                 userOnConnectionChange(newTransportConnected);
             }
             if (newTransportConnected && !internalState.isLoading) {
                 console.log(`[ReqDelta Client] Reconnected for topic "${topic}". Triggering refresh.`);
                 requestInitialState(true);
             }
        }
    };

    const reapplyPendingUpdates = (): State => { // Ensure return type is State, not undefined
        let computedOptimisticState = cloneState(internalState.confirmedState);

        // If confirmed state is undefined (e.g., after error) OR cloning fails, start from initial state
        if (computedOptimisticState === undefined) {
            console.warn("[ReqDelta Client] Confirmed state is undefined or cloning failed during reapplication. Starting rebase from initial state.");
            computedOptimisticState = cloneState(initialState);
             // If even cloning initial state fails, this is a critical error.
             if (computedOptimisticState === undefined) {
                 console.error("[ReqDelta Client] CRITICAL: Failed to clone initial state during reapplication. State is inconsistent.");
                 // Return current optimistic state as absolute fallback, but it might be wrong
                 return internalState.optimisticState;
             }
        }

        const sortedClientSeqs = [...pendingUpdates.keys()].sort((a, b) => a - b);
        for (const clientSeq of sortedClientSeqs) {
            const pending = pendingUpdates.get(clientSeq);
            if (pending) {
                try {
                    // Apply delta. computedOptimisticState is guaranteed to be State type here.
                    computedOptimisticState = applyDelta(computedOptimisticState, pending.delta);
                    // applyDelta MUST return State, not undefined
                    if (computedOptimisticState === undefined) {
                         throw new Error(`applyDelta returned undefined during rebase of clientSeq ${clientSeq}`);
                    }
                } catch (err) {
                    console.error(`[ReqDelta Client] Error reapplying pending delta (clientSeq: ${clientSeq}) during rebase:`, err);
                    setState({ error: new Error(`Error reapplying pending delta ${clientSeq}`) });
                    // If rebase fails, return the state *before* the failing delta was applied
                    // This prevents using a potentially corrupt state.
                    return computedOptimisticState ?? initialState; // Fallback to initial if everything failed
                }
            }
        }
        // computedOptimisticState is guaranteed to be State here
        return computedOptimisticState;
    };


    // --- Message Processing Functions ---

    const processSyncQueue = () => {
        // Sort queue just in case updates arrived out of order during sync
        syncQueue.sort((a, b) => (a.serverSeq ?? 0) - (b.serverSeq ?? 0));
        const queueToProcess = [...syncQueue];
        syncQueue = []; // Clear queue before processing

        console.log(`[ReqDelta Client] Processing ${queueToProcess.length} queued updates after sync.`);
        let processingError = false;
        for (const update of queueToProcess) {
             // Re-check sequence relative to lastServerSeq now
             const updateSeq = update.serverSeq ?? -1;
             if (updateSeq === internalState.lastServerSeq + 1) {
                 // Process normally (will update lastServerSeq and state)
                 // Temporarily set isSyncing false to allow normal processing
                 const wasSyncing = internalState.isSyncing;
                 internalState.isSyncing = false;
                 handleServerUpdate(update);
                 internalState.isSyncing = wasSyncing; // Restore if needed

                 // If handleServerUpdate encountered an error, it would set state.error
                 if (internalState.error) {
                     console.error(`[ReqDelta Client] Error occurred while processing update ${updateSeq} from sync queue. Stopping queue processing.`);
                     processingError = true;
                     syncQueue = queueToProcess.slice(queueToProcess.indexOf(update)); // Put remaining back
                     break;
                 }
             } else if (updateSeq <= internalState.lastServerSeq) {
                 console.warn(`[ReqDelta Client] Skipping already processed or stale update ${updateSeq} from sync queue.`);
             } else {
                 // Still a gap? This indicates a problem, maybe re-trigger sync?
                 console.error(`[ReqDelta Client] Gap still detected after sync while processing queue (expected ${internalState.lastServerSeq + 1}, got ${updateSeq}). Re-triggering sync.`);
                 processingError = true;
                 syncQueue = queueToProcess.slice(queueToProcess.indexOf(update)); // Put remaining back
                 setState({ error: new Error(`Sync queue processing failed due to gap at ${updateSeq}`), isSyncing: true });
                 requestMissingUpdates(internalState.lastServerSeq, updateSeq); // Request again, this updates syncTargetSeq
                 break; // Stop processing queue
             }
        }
         // If queue processed fully without new errors/gaps, ensure syncing is false
         if (!processingError && syncQueue.length === 0 && internalState.isSyncing) {
             console.log("[ReqDelta Client] Sync queue processed successfully.");
             setState({ isSyncing: false });
         }
    };


    const handleServerAck = (ack: ServerAckMessage) => {
        if (!optimisticEnabled) return;

        const pending = pendingUpdates.get(ack.clientSeq);
        if (!pending) {
            console.warn(`[ReqDelta Client] Received ack for unknown clientSeq: ${ack.clientSeq}`);
            return;
        }

        pendingUpdates.delete(ack.clientSeq);

        if (ack.success) {
            console.log(`[ReqDelta Client] Optimistic update ${ack.clientSeq} confirmed by server (serverSeq: ${ack.serverSeq}).`);
            // Assuming server sends 'update' messages for state changes. Ack just clears queue.
        } else {
            console.warn(`[ReqDelta Client] Optimistic update ${ack.clientSeq} rejected by server: ${ack.conflictReason}`);
            const recalculatedOptimisticState = reapplyPendingUpdates(); // Returns State
            setState({
                optimisticState: recalculatedOptimisticState, // Rollback view
                error: new Error(`Optimistic update ${ack.clientSeq} rejected: ${ack.conflictReason}`),
            });
        }

        if (pendingUpdates.size === 0 && internalState.confirmedState !== undefined) {
              const currentConfirmed = internalState.confirmedState;
              // Deep compare might be better if feasible
              if (JSON.stringify(internalState.optimisticState) !== JSON.stringify(currentConfirmed)) {
                  console.log("[ReqDelta Client] Pending queue empty, converging optimistic state to confirmed state.");
                  const clonedConfirmed = cloneState(currentConfirmed);
                  if (clonedConfirmed !== undefined) {
                     setState({ optimisticState: clonedConfirmed });
                  } else {
                     console.error("[ReqDelta Client] Failed to clone confirmed state for convergence. State might be inconsistent.");
                     // Revert to initial state as a last resort?
                     setState({ optimisticState: initialState, error: new Error("Convergence clone failed") });
                  }
              }
         }
    };

     // --- Main Update Handler ---
     const handleServerUpdate = (update: UpdateMessage<Delta>) => {
        console.log(`[ReqDelta Client] Received server update (serverSeq: ${update.serverSeq}).`);
        const serverSeq = update.serverSeq ?? -1;

        // --- Syncing State ---
        if (internalState.isSyncing) {
            // Process update if it's the next expected one during sync
            if (serverSeq === internalState.lastServerSeq + 1) {
                console.log(`[ReqDelta Client] Applying update ${serverSeq} during sync.`);
                // Apply update logic (similar to non-syncing case but adapted)
                let newConfirmedState: State;
                try {
                    newConfirmedState = applyDelta(internalState.confirmedState, update.delta);
                    if (newConfirmedState === undefined) { throw new Error("applyDelta returned undefined during sync update"); }
                } catch (err) {
                    console.error(`[ReqDelta Client] Error applying server delta ${serverSeq} during sync:`, err);
                    setState({ error: new Error(`Failed apply update ${serverSeq}: ${err}`), isSyncing: false, /* syncTargetSeq: -1 // Reset target? */ }); // Error state exits sync mode
                    syncQueue = []; // Clear queue on error during sync
                    return;
                }

                // Calculate new optimistic state (rebase)
                let finalOptimisticState: State = newConfirmedState;
                if (optimisticEnabled && pendingUpdates.size > 0) {
                    // Simplified rebase placeholder:
                    // Ensure reapplyPendingUpdates uses newConfirmedState as its base for calculations
                    // This requires reapplyPendingUpdates to accept the base state or read it correctly
                    // For now, assume reapply reads internalState.confirmedState which we just updated.
                    // TODO: Refine reapplyPendingUpdates to accept a base state for correctness.
                    finalOptimisticState = reapplyPendingUpdates() ?? newConfirmedState;
                }

                setState({
                    confirmedState: newConfirmedState,
                    optimisticState: finalOptimisticState,
                    lastServerSeq: serverSeq,
                    // Keep isSyncing = true until target reached
                });

                // Check if sync completed
                if (serverSeq === syncTargetSeq) {
                    console.log(`[ReqDelta Client] Sync completed at seq ${serverSeq}. Processing queue.`);
                    // syncTargetSeq = -1; // Reset target? Or let processSyncQueue handle it? Keep it for now.
                    // Process queue *after* setting state, potentially triggering more updates
                    processSyncQueue(); // This might set isSyncing = false if queue is empty and no new gaps found
                }

            } else if (serverSeq > internalState.lastServerSeq + 1) {
                // Received another gap while already syncing? Or an out-of-order historical update.
                // Queue it and wait for the sequence to catch up.
                console.warn(`[ReqDelta Client] Queuing out-of-sequence update ${serverSeq} received during sync.`);
                // Avoid duplicates in queue
                if (!syncQueue.some(item => item.serverSeq === serverSeq)) {
                    syncQueue.push(update);
                }
            } else {
                // Stale update received during sync (seq <= lastServerSeq)
                console.warn(`[ReqDelta Client] Ignoring stale update ${serverSeq} received during sync.`);
            }
            return; // Finished processing for syncing state
        }

        // --- Not Syncing State ---

        if (serverSeq > 0 && internalState.lastServerSeq > 0) {
            const expectedNextSeq = internalState.lastServerSeq + 1;
            if (serverSeq < expectedNextSeq) {
                console.warn(`[ReqDelta Client] Received stale update ${serverSeq} (expected >= ${expectedNextSeq}). Ignoring.`);
                return;
            } else if (serverSeq > expectedNextSeq) {
                // Gap detected!
                console.warn(`[ReqDelta Client] Sequence gap detected! Expected ${expectedNextSeq}, got ${serverSeq}. Requesting missing.`);
                setState({ isSyncing: true }); // Set syncing true *before* request
                requestMissingUpdates(internalState.lastServerSeq, serverSeq); // This sets syncTargetSeq
                // Queue the current update that triggered the gap detection
                syncQueue = [update]; // Start queue with this update
                return; // Stop processing this update now
            }
        }

        // --- Apply update normally (not syncing, sequence correct or first update) ---
        let newConfirmedState: State;
        try {
             newConfirmedState = applyDelta(internalState.confirmedState, update.delta);
             if (newConfirmedState === undefined) { throw new Error("applyDelta returned undefined for confirmed state update"); }
        } catch (err) {
            console.error(`[ReqDelta Client] Error applying server delta ${serverSeq} to confirmed state:`, err);
            setState({ error: new Error(`Failed apply update ${serverSeq}: ${err}`), isSyncing: false }); // Ensure isSyncing false on error here
            return;
        }

        let finalOptimisticState: State = newConfirmedState;
        if (optimisticEnabled && pendingUpdates.size > 0) {
            console.log(`[ReqDelta Client] Rebasing ${pendingUpdates.size} pending updates onto new confirmed state (serverSeq: ${serverSeq}).`);
            let rebaseState: State | undefined = cloneState(newConfirmedState); // Clone the *new* confirmed state
            if (rebaseState === undefined) {
                console.error("[ReqDelta Client] Failed to clone new confirmed state for rebasing. State might be inconsistent.");
                setState({ error: new Error("Failed to clone state for rebase") });
                finalOptimisticState = newConfirmedState; // Fallback
            } else {
                 // TODO: Refine reapplyPendingUpdates to accept base state
                 // Assume reapplyPendingUpdates correctly uses rebaseState as base
                 finalOptimisticState = reapplyPendingUpdates() ?? newConfirmedState;
            }
        }

        setState({
            confirmedState: newConfirmedState,
            optimisticState: finalOptimisticState,
            lastServerSeq: serverSeq > 0 ? serverSeq : internalState.lastServerSeq,
            isLoading: false,
            error: undefined,
            isSyncing: false,
        });
        setState({
            confirmedState: newConfirmedState,
            optimisticState: finalOptimisticState,
            lastServerSeq: serverSeq > 0 ? serverSeq : internalState.lastServerSeq,
            isLoading: false,
            error: undefined,
            isSyncing: false, // Explicitly false after successful normal update
        });
    };


    const handleIncomingMessage = (message: ReqDeltaMessage<ReqP, ResP, Delta>) => {
        if (!isStoreConnected || message.topic !== topic) return;

        switch (message.type) {
            case 'response':
                const responseData = message.payload as ResP;
                if (message.error) {
                    console.error(`[ReqDelta Client] Error fetching initial state for topic "${topic}":`, message.error);
                    setState({
                        isLoading: false,
                        error: message.error,
                        confirmedState: undefined,
                        optimisticState: initialState, // Reset optimistic to initial
                        lastServerSeq: 0,
                        isSyncing: false,
                    });
                    pendingUpdates.clear();
                } else {
                    console.log(`[ReqDelta Client] Received initial state for topic "${topic}".`);
                    pendingUpdates.clear();
                    const initialStateData = responseData as unknown as State;
                    const clonedInitial = cloneState(initialStateData);

                    if (clonedInitial === undefined && initialStateData !== undefined) {
                         console.error(`[ReqDelta Client] Failed to clone initial state for topic "${topic}". Store may be inconsistent.`);
                         setState({
                              isLoading: false,
                              error: new Error("Failed to clone initial state"),
                              confirmedState: undefined,
                              optimisticState: initialState, // Fallback
                              lastServerSeq: 0,
                              isSyncing: false,
                         });
                    } else {
                         // clonedInitial is State | undefined, but if initialStateData was defined, clone should succeed or return original
                         // If initialStateData was undefined, clonedInitial is undefined.
                         // We need optimisticState to be State.
                         const finalInitialState = clonedInitial ?? initialState; // Ensure non-undefined using original initial state
                         setState({
                              isLoading: false,
                              confirmedState: initialStateData,
                              optimisticState: finalInitialState, // Use the processed initial state
                              error: undefined,
                              lastServerSeq: 0, // Reset sequence
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
            // Other cases remain the same
             case 'client_update':
             case 'missing_updates':
             case 'request':
             case 'subscribe':
             case 'unsubscribe':
                 console.warn(`[ReqDelta Client] Received unexpected message type "${message.type}" from server. Ignoring.`);
                 break;
             default:
                  console.log(`[ReqDelta Client] Received unknown message type, possibly custom:`, message);
                 break;
        }
    };

    // --- Outgoing Messages ---

    const sendMessage = async (message: ReqDeltaMessage) => {
       if (!isStoreConnected) {
            console.warn(`[ReqDelta Client] Attempted to send message while store is disconnected:`, message);
            return Promise.reject(new Error("Store disconnected"));
        }
       if (!internalState.isConnected) {
            console.warn(`[ReqDelta Client] Attempted to send message while transport is disconnected:`, message);
            // TODO: Offline queuing?
            return Promise.reject(new Error("Transport disconnected"));
       }
        try {
            await Promise.resolve(transport.sendMessage(message));
        } catch (err) {
            console.error(`[ReqDelta Client] Error sending message for topic "${topic}":`, err);
            setState({ error: new Error(`Failed to send message: ${err}`) });
            throw err;
        }
    };

     const requestInitialState = (isReconnect: boolean = false) => {
        if (!isStoreConnected) return;
        if (isReconnect || !optimisticEnabled) {
             pendingUpdates.clear();
        }
        setState({ isLoading: true, error: undefined, isSyncing: true });
        const requestId = generateRequestId();
        const requestMsg: RequestMessage<ReqP> = {
            type: 'request',
            id: requestId,
            topic: topic,
            ...(requestPayload !== undefined && { payload: requestPayload }),
        };
        sendMessage(requestMsg).catch(() => {
             setState({ isLoading: false, isSyncing: false });
        });
    };

    const subscribeToUpdates = () => {
        if (!isStoreConnected) return;
        const subscribeId = generateRequestId();
        const subscribeMsg: SubscribeMessage = { type: 'subscribe', id: subscribeId, topic: topic };
        sendMessage(subscribeMsg).catch(err => {
             console.error(`[ReqDelta Client] Failed to send subscribe message:`, err);
        });
    };

    const unsubscribeFromUpdates = () => {
        const unsubscribeId = generateRequestId();
        const unsubscribeMsg: UnsubscribeMessage = { type: 'unsubscribe', id: unsubscribeId, topic: topic };
         sendMessage(unsubscribeMsg).catch(err => {
             console.warn(`[ReqDelta Client] Error sending unsubscribe on disconnect:`, err);
         });
    };

    // --- Outgoing Message Functions ---

     const requestMissingUpdates = (from: number, to: number) => {
        if (!isStoreConnected || !internalState.isConnected) {
             console.warn("[ReqDelta Client] Cannot request missing updates: Not connected.");
             return;
        }
        console.log(`[ReqDelta Client] Requesting missing updates for topic "${topic}" from ${from} to ${to}.`);
        syncTargetSeq = to; // Store the target sequence we expect to reach
        const requestMsg: MissingUpdatesRequestMessage = {
            type: 'missing_updates',
            topic: topic, // Already known, but include for clarity
            fromSeq: from, // Exclusive
            toSeq: to, // Inclusive
        };
        sendMessage(requestMsg).catch(err => {
             console.error(`[ReqDelta Client] Failed to send request for missing updates:`, err);
             // If request fails, exit sync mode and set error
             setState({ isSyncing: false, syncTargetSeq: -1, error: new Error(`Failed request missing updates: ${err}`) }); // Removed syncTargetSeq from here
             syncQueue = []; // Clear queue as sync failed
        });
    };

    // --- Store API Implementation ---

    const performOperation = (operation: Operation): number => {
        if (!isStoreConnected) {
            console.error("[ReqDelta Client] Cannot perform operation: Store is disconnected.");
            return -1;
        }
         if (!internalState.isConnected) {
             console.error("[ReqDelta Client] Cannot perform operation: Transport is disconnected.");
             return -1;
         }
        if (!optimisticEnabled || !operationToDelta || !clientSeqManager) {
            console.warn("[ReqDelta Client] Optimistic updates not enabled. Operation ignored:", operation);
            return -1;
        }
        // internalState.optimisticState is guaranteed to be State
        const currentOptimisticState = internalState.optimisticState;

        let delta: Delta | null;
        try {
            delta = operationToDelta(operation, currentOptimisticState);
        } catch (err) {
            console.error("[ReqDelta Client] Error converting operation to delta:", err);
            setState({ error: new Error(`Failed to process operation: ${err}`) });
            return -1;
        }

        if (delta === null) {
            console.log("[ReqDelta Client] operationToDelta returned null, operation skipped:", operation);
            return -1;
        }

        const clientSeq = clientSeqManager.getNext();
        const clonedSnapshot: State | undefined = cloneState(currentOptimisticState);
        if (clonedSnapshot === undefined) {
             console.error("[ReqDelta Client] Failed to clone state for snapshot. Cannot apply optimistic update.");
             return -1;
        }
        const snapshot: State = clonedSnapshot; // Now State type

        let newOptimisticState: State;
        try {
            newOptimisticState = applyDelta(currentOptimisticState, delta);
             if (newOptimisticState === undefined) { // Should not happen
                 throw new Error("applyDelta returned undefined for optimistic update");
             }
        } catch (err) {
            console.error("[ReqDelta Client] Error applying optimistic delta:", err);
            setState({ error: new Error(`Failed to apply optimistic update ${clientSeq}: ${err}`) });
            return -1;
        }

        const pending: PendingUpdate<State, Delta, Operation> = { // Added Operation generic
             operation,
             delta,
             snapshot,
             timestamp: Date.now(),
             clientSeq
        };
        pendingUpdates.set(clientSeq, pending);
        setState({ optimisticState: newOptimisticState, error: undefined });

        const clientUpdateMsg: ClientUpdateMessage<Delta> = {
            type: 'client_update',
            topic: topic,
            clientSeq: clientSeq,
            delta: delta,
            timestamp: Date.now(),
        };
        sendMessage(clientUpdateMsg).catch(err => {
            console.error(`[ReqDelta Client] Failed to send optimistic update ${clientSeq} to server:`, err);
        });

        return clientSeq;
    };

    // --- Initialization ---
    cleanupTransportOnMessage = transport.onMessage(handleIncomingMessage);
    if (transport.onConnectionChange) {
        cleanupTransportOnConnection = transport.onConnectionChange(updateConnectionStatus);
    }
    if (internalState.isConnected) {
        requestInitialState();
        subscribeToUpdates();
    } else {
        console.warn(`[ReqDelta Client] Transport initially disconnected for topic "${topic}". Waiting for connection.`);
        setState({ isLoading: false });
    }
    // --- End Initialization ---

    const storeApi: ReqDeltaStore<State, Operation> = {
        getState: () => Object.freeze({ ...internalState }),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refresh: () => {
            if (isStoreConnected) {
                requestInitialState();
            } else {
                console.warn(`[ReqDelta Client] Cannot refresh store for topic "${topic}" as it is disconnected.`);
            }
        },
        disconnect: () => {
            if (!isStoreConnected) return;
            isStoreConnected = false;
            // Try to unsubscribe, but don't wait or rely on it
            if (internalState.isConnected) {
                 unsubscribeFromUpdates();
            }
            // Clean up listeners
             if (typeof cleanupTransportOnMessage === 'function') cleanupTransportOnMessage();
             if (typeof cleanupTransportOnConnection === 'function') cleanupTransportOnConnection();
             listeners.clear();
             pendingUpdates.clear();

             // Final state update
             const finalConfirmed = internalState.confirmedState;
              const clonedConfirmed = finalConfirmed !== undefined ? cloneState(finalConfirmed) : undefined;
              // Ensure finalOptimistic is State type. cloneState returns State | undefined.
              const finalOptimistic: State = clonedConfirmed ?? initialState; // Use nullish coalescing

              setState({
                   isLoading: false,
                  error: new Error("Disconnected by client"),
                  optimisticState: finalOptimistic,
                  // confirmedState remains as it was
                  isSyncing: false,
                  isConnected: false // Reflect disconnect
             });
             console.log(`[ReqDelta Client] Store disconnected for topic "${topic}".`);
        },
        performOperation,
    };

    return storeApi;
}
