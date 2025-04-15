// NOTE: This file is based on the OLD ReqDelta architecture and needs SIGNIFICANT REFACTORING
// to align with the TypeQL structure (paths, request/result, subscription lifecycle, new transport).
// The changes below are minimal fixes for type errors and placeholders.

import type {
    TypeQLTransport,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage, // Keep for initiating
    UnsubscribeMessage, // Keep this for stopping? Maybe use unsubscribeFn instead? Type needs clarification.
    SubscriptionDataMessage, // For receiving data
    SubscriptionHandlers, // Needed for subscribe call
    SubscriptionErrorMessage, // For receiving errors
    SubscriptionEndMessage, // For receiving end signal
    StandardDelta, // Keep if standard deltas are still relevant
    StandardOperation, // Keep if standard operations are still relevant
    UnsubscribeFn // Import the unsubscribe function type
    // Remove old/unused types
} from '../core/types';
import {
    generateId,
    // Keep standard utils if used, might need adaptation
    applyStandardDelta,
    standardOperationToDelta,
    standardMatchesPendingOperation,
    defaultCloneState as cloneStateUtil
} from '../core/utils';
// Sequence manager likely needs rework for TypeQL's model
// import { createClientSequenceManager } from '../core/seqManager';
import type { ConflictResolverConfig } from './conflictResolver'; // Conflict logic needs rework

// Sequence manager type removed as implementation is commented out


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
    transport: TypeQLTransport; // Use TypeQLTransport
    /** The topic to subscribe to. */
    // topic: string; // Replaced by path
    /** Path to the specific procedure this store interacts with (e.g., a subscription or query for initial state). */
    path: string;
    /** Initial state. Required. */
    initialState: State;
    // requestPayload?: ReqP; // Input payload handled differently

    /**
     * Function to apply incoming deltas (server or optimistic) to the current state.
     * Must return the new state. Defaults to `applyStandardDelta`.
     * @param currentState The current state (can be undefined during initial phases).
      * @param delta The incoming delta.
      * @returns The new state after applying the data/delta. MUST NOT return undefined unless error.
      */
    applyUpdate?: (currentState: State | undefined, data: Delta /* or State? */) => State; // Renamed from applyDelta

     // --- Optimistic Update Options (Optional - Needs Rework) ---
    /**
     * Placeholder: Converts an operation into a delta for optimistic updates. Needs rework.
     */
    operationToOptimisticData?: (operation: Operation, currentState: State) => Delta | null; // Renamed
    /**
     * Placeholder: Matches incoming data to pending operations. Needs rework.
     */
    matchesPendingOperation?: (data: Delta /* or State? */, operation: Operation) => boolean;
    /** Configuration for conflict resolution. Required if optimistic updates are enabled. Needs rework. */
    conflictConfig?: ConflictResolverConfig<unknown>; // Delta type unknown here

    // --- Other Options ---
    /** Optional function to generate unique request/message IDs (string or number for TypeQL). */
    generateRequestId?: () => string | number;
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
    // Ensure options uses the Item generic correctly. Needs path instead of topic.
    options: CreateStoreOptions<State, Item, Delta, Operation, ReqP, ResP>
): ReqDeltaStore<State, Operation> {
    const {
        transport,
        path, // Use path instead of topic
        initialState, // Required
        // requestPayload, // Handled differently
        // --- Delta Application ---
        applyUpdate: userApplyUpdate, // Renamed from applyDelta
        collectionPath, // Used by default standard delta logic (may need rework)
        // --- Optimistic Config (Needs Rework) ---
        operationToOptimisticData: userOperationToOptimisticData, // Renamed
        matchesPendingOperation: userMatchesPendingOperation,
        conflictConfig, // Required for optimistic updates, needs rework
        // --- Utils ---
        generateRequestId = generateId,
        cloneState = cloneStateUtil, // Use the imported aliased function
        onConnectionChange: userOnConnectionChange,
        // optimisticTimeout // TODO
    } = options;

    // Determine if optimistic updates are enabled (based on renamed option)
    const optimisticEnabled = !!userOperationToOptimisticData;
    if (optimisticEnabled && !conflictConfig) {
        // Make it an error instead of a warning? For now, warn.
        console.warn(`[ReqDelta - Needs Rework] Optimistic updates enabled ('operationToOptimisticData' provided) but 'conflictConfig' is missing. Conflicts may not be handled correctly.`);
    }

    // --- Setup Default Functions (Needs Rework) ---
    // Adapt applyDelta to applyUpdate
     const applyUpdate = userApplyUpdate ?? ((currentState: State | undefined, data: Delta): State => {
         // Default logic assumes data is compatible with StandardDelta<Item, State> - This needs review for TypeQL
         const pathAwareData = {
             ...(data as any), // Cast needed as Delta might not be StandardDelta
             path: (data as any).path ?? collectionPath ?? [],
         };
         const standardData = pathAwareData as StandardDelta<Item, State>; // Assume it's a standard delta for default

         // Handle undefined currentState for default applicator
         if (currentState === undefined) {
             if (standardData.type === 'replace') {
                 return standardData.state;
             }
             if (standardData.type === 'add' && (standardData.path ?? []).length === 0) {
                 // This assumption is weak, but necessary for a default. User should override if state isn't Item[].
                 return [standardData.item] as unknown as State;
             }
             console.warn(`[ReqDelta - Needs Rework] Default applyUpdate cannot apply data type "${standardData.type}" to undefined state. Returning initial state.`);
             return initialState;
         }

         // Apply using the standard function if currentState is defined
         // Ensure Item generic is correctly passed to applyStandardDelta (needs review)
         return applyStandardDelta<State, Item>(currentState, standardData);
    });

    // Adapt operationToDelta to operationToOptimisticData
    const operationToOptimisticData = userOperationToOptimisticData ?? (optimisticEnabled
        // Pass Item generic to standardOperationToDelta. It only takes the operation. Needs review.
        ? (op: Operation, _currentState: State) => standardOperationToDelta<Item, State>(op as StandardOperation<Item>) as Delta | null
        : undefined);

    // Adapt matchesPendingOperation
    const matchesPendingOperation = userMatchesPendingOperation ?? (optimisticEnabled
        // Pass Item generic to standardMatchesPendingOperation. Needs review.
        ? (data: Delta, op: Operation) => standardMatchesPendingOperation<Item, State>(data as StandardDelta<Item, State>, op as StandardOperation<Item>)
        : undefined);

    // --- Internal State (Sequence Manager Removed) ---
    // const clientSeqManager: ClientSequenceManager | null = optimisticEnabled ? createClientSequenceManager() : null;
    let clientSeqCounter = 0; // Use temporary counter
    let internalState: StoreState<State> = {
        confirmedState: initialState, // Initialize confirmed state with initial state
        optimisticState: initialState, // Optimistic state also starts with initial state
        isLoading: false,
        error: undefined,
        lastServerSeq: 0, // Sequence logic needs rework
        isSyncing: false,
        isConnected: transport.connected ?? true, // Use TypeQLTransport
        syncTargetSeq: -1, // Initialize syncTargetSeq (logic needs rework)
    };

    const pendingUpdates = new Map<number, PendingUpdate<State, Delta, Operation>>(); // Needs rework for TypeQL mutation tracking
    const listeners = new Set<(state: Readonly<StoreState<State>>) => void>();
    // let cleanupTransportOnMessage: (() => void) | void | undefined; // Replaced by unsubscribeFn
    let cleanupTransportOnConnection: (() => void) | void | undefined;
    let unsubscribeFn: UnsubscribeFn | undefined; // Store unsubscribe function from transport.subscribe
    let isStoreConnected = true;
    // Queue for updates received while syncing missing ones (logic needs rework)
    let syncQueue: SubscriptionDataMessage[] = []; // Use new message type
    // Track the target sequence number during sync recovery (logic needs rework)
    // let syncTargetSeq = -1; // Covered by internalState.syncTargetSeq

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
                 // Use path variable
                 console.log(`[ReqDelta - Needs Rework] Reconnected for path "${path}". Triggering refresh.`);
                 requestInitialState(true);
             }
        }
    };

    // TODO: Rework reapplyPendingUpdates for TypeQL
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
                    // Apply update. computedOptimisticState is guaranteed to be State type here.
                    computedOptimisticState = applyUpdate(computedOptimisticState, pending.delta); // Use applyUpdate
                    // applyUpdate MUST return State, not undefined
                    if (computedOptimisticState === undefined) {
                         throw new Error(`applyUpdate returned undefined during rebase of clientSeq ${clientSeq}`);
                    }
                } catch (err) {
                    console.error(`[ReqDelta - Needs Rework] Error reapplying pending delta (clientSeq: ${clientSeq}) during rebase:`, err);
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


    // --- Message Processing Functions (Needs Rework for TypeQL) ---

    // TODO: Rework processSyncQueue for TypeQL
    const processSyncQueue = () => {
        // Sort queue based on sequence number (if available)
        syncQueue.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        const queueToProcess = [...syncQueue];
        syncQueue = []; // Clear queue before processing

        console.log(`[ReqDelta - Needs Rework] Processing ${queueToProcess.length} queued updates after sync.`);
        let processingError = false;
        for (const dataMsg of queueToProcess) {
             // Re-check sequence relative to lastServerSeq now (Needs Rework)
             const updateSeq = dataMsg.seq ?? -1;
             if (updateSeq === internalState.lastServerSeq + 1) {
                 // Process normally (will update lastServerSeq and state)
                 // Temporarily set isSyncing false to allow normal processing
                 const wasSyncing = internalState.isSyncing;
                 internalState.isSyncing = false;
                 handleSubscriptionData(dataMsg); // Use adapted handler
                 internalState.isSyncing = wasSyncing; // Restore if needed

                 // If handleSubscriptionData encountered an error, it would set state.error
                 if (internalState.error) {
                     console.error(`[ReqDelta - Needs Rework] Error occurred while processing update ${updateSeq} from sync queue. Stopping queue processing.`);
                     processingError = true;
                     syncQueue = queueToProcess.slice(queueToProcess.indexOf(dataMsg)); // Put remaining back
                     break;
                 }
             } else if (updateSeq <= internalState.lastServerSeq) {
                 console.warn(`[ReqDelta - Needs Rework] Skipping already processed or stale update ${updateSeq} from sync queue.`);
             } else {
                 // Still a gap? This indicates a problem, maybe re-trigger sync?
                 console.error(`[ReqDelta - Needs Rework] Gap still detected after sync while processing queue (expected ${internalState.lastServerSeq + 1}, got ${updateSeq}). Re-triggering sync.`);
                 processingError = true;
                 syncQueue = queueToProcess.slice(queueToProcess.indexOf(dataMsg)); // Put remaining back
                 setState({ error: new Error(`Sync queue processing failed due to gap at ${updateSeq}`), isSyncing: true });
                 // requestMissingUpdates(internalState.lastServerSeq, updateSeq); // Request again, this updates syncTargetSeq (Needs Rework)
                 console.warn("requestMissingUpdates needs rework for TypeQL")
                 break; // Stop processing queue
             }
        }
         // If queue processed fully without new errors/gaps, ensure syncing is false
         if (!processingError && syncQueue.length === 0 && internalState.isSyncing) {
             console.log("[ReqDelta - Needs Rework] Sync queue processed successfully.");
             setState({ isSyncing: false, syncTargetSeq: -1 }); // Reset sync target
         }
    };

    // TODO: Rework handleServerAck equivalent if needed for optimistic mutations in TypeQL
    // const handleServerAck = (ack: ServerAckMessage) => { ... };

    // --- Main Update Handler (Adapted for SubscriptionDataMessage) ---
    const handleSubscriptionData = (dataMsg: SubscriptionDataMessage) => {
        const data = dataMsg.data as Delta; // Assume data is Delta for now
        const serverSeq = dataMsg.seq; // Use 'seq' from new message type
        console.log(`[ReqDelta - Needs Rework] Received subscription data (seq: ${serverSeq}).`);

        // --- Syncing State (Logic Needs Rework) ---
        if (internalState.isSyncing) {
            // Process update if it's the next expected one during sync
            if (serverSeq !== undefined && serverSeq === internalState.lastServerSeq + 1) {
                console.log(`[ReqDelta - Needs Rework] Applying update ${serverSeq} during sync.`);
                // Apply update logic
                let newConfirmedState: State;
                try {
                    newConfirmedState = applyUpdate(internalState.confirmedState, data);
                    if (newConfirmedState === undefined) { throw new Error("applyUpdate returned undefined during sync update"); }
                } catch (err) {
                    console.error(`[ReqDelta - Needs Rework] Error applying server data (seq ${serverSeq}) during sync:`, err);
                    setState({ error: new Error(`Failed apply update ${serverSeq}: ${err}`), isSyncing: false, syncTargetSeq: -1 }); // Error state exits sync mode
                    syncQueue = []; // Clear queue on error
                    return;
                }

                // Rebase optimistic state (Needs Rework)
                let finalOptimisticState: State = newConfirmedState;
                if (optimisticEnabled && pendingUpdates.size > 0) {
                     console.warn("Rebase logic during sync needs rework for TypeQL");
                     finalOptimisticState = reapplyPendingUpdates() ?? newConfirmedState; // Placeholder
                }

                setState({
                    confirmedState: newConfirmedState,
                    optimisticState: finalOptimisticState,
                    lastServerSeq: serverSeq,
                    // Keep isSyncing = true until target reached
                    syncTargetSeq: internalState.syncTargetSeq, // Keep existing target
                });

                // Check if sync completed
                if (serverSeq === internalState.syncTargetSeq) {
                    console.log(`[ReqDelta - Needs Rework] Sync possibly completed at seq ${serverSeq}. Processing queue.`);
                    // Process queue *after* setting state
                    processSyncQueue(); // This might set isSyncing = false
                }

            } else if (serverSeq !== undefined && serverSeq > internalState.lastServerSeq + 1) {
                 console.warn(`[ReqDelta - Needs Rework] Queuing out-of-sequence update ${serverSeq} received during sync.`);
                 if (!syncQueue.some(item => item.seq === serverSeq)) {
                     syncQueue.push(dataMsg);
                 }
            } else {
                 console.warn(`[ReqDelta - Needs Rework] Ignoring stale update ${serverSeq ?? 'undefined'} received during sync.`);
            }
            return; // Finished processing for syncing state
        }

        // --- Not Syncing State (Sequence Check Needs Rework) ---
        if (serverSeq !== undefined && internalState.lastServerSeq > 0) {
            const expectedNextSeq = internalState.lastServerSeq + 1;
            if (serverSeq < expectedNextSeq) {
                console.warn(`[ReqDelta - Needs Rework] Received stale update ${serverSeq} (expected >= ${expectedNextSeq}). Ignoring.`);
                return;
            } else if (serverSeq > expectedNextSeq) {
                // Gap detected!
                console.warn(`[ReqDelta - Needs Rework] Sequence gap detected! Expected ${expectedNextSeq}, got ${serverSeq}. Requesting missing.`);
                setState({ isSyncing: true, syncTargetSeq: serverSeq }); // Set sync target
                // requestMissingUpdates(internalState.lastServerSeq, serverSeq); // Needs rework
                console.warn("requestMissingUpdates needs rework for TypeQL");
                syncQueue = [dataMsg]; // Start queue with this update
                return; // Stop processing this update now
            }
        }

        // --- Apply update normally (not syncing, sequence correct or first update) ---
        let newConfirmedState: State;
        try {
             newConfirmedState = applyUpdate(internalState.confirmedState, data);
             if (newConfirmedState === undefined) { throw new Error("applyUpdate returned undefined for confirmed state update"); }
        } catch (err) {
            console.error(`[ReqDelta - Needs Rework] Error applying server data (seq ${serverSeq}) to confirmed state:`, err);
            setState({ error: new Error(`Failed apply update ${serverSeq}: ${err}`), isSyncing: false });
            return;
        }

        // Rebase optimistic state (Needs Rework)
        let finalOptimisticState: State = newConfirmedState;
        if (optimisticEnabled && pendingUpdates.size > 0) {
             console.log(`[ReqDelta - Needs Rework] Rebasing ${pendingUpdates.size} pending updates onto new confirmed state (seq: ${serverSeq}).`);
             const rebasedState = reapplyPendingUpdates(); // Needs rework
             if (rebasedState !== undefined) {
                 finalOptimisticState = rebasedState;
             } else {
                  console.error("[ReqDelta - Needs Rework] Rebase failed, could not recalculate optimistic state.");
                  finalOptimisticState = newConfirmedState; // Fallback
             }
        }

        setState({
            confirmedState: newConfirmedState,
            optimisticState: finalOptimisticState,
            lastServerSeq: serverSeq !== undefined ? serverSeq : internalState.lastServerSeq,
            isLoading: false,
            error: undefined,
            isSyncing: false, // Explicitly false after successful normal update
        });
    };

    const handleSubscriptionError = (error: SubscriptionErrorMessage['error']) => {
        console.error(`[ReqDelta - Needs Rework] Subscription error for path "${path}":`, error.message);
        setState({ isLoading: false, error: error.message || 'Subscription error', isConnected: false /* Assume disconnect on error? */ });
        unsubscribeFn = undefined; // Clear unsubscribe function
    };

    const handleSubscriptionEnd = () => {
        console.log(`[ReqDelta - Needs Rework] Subscription ended normally for path "${path}".`);
        setState({ isLoading: false, error: undefined });
        unsubscribeFn = undefined; // Clear unsubscribe function
    };


    // --- Outgoing Message Functions (Needs Rework) ---

    // Replace old sendMessage with TypeQL request/subscribe calls

    // Fetch initial state using transport.request (assuming a query)
    const requestInitialState = async (isReconnect: boolean = false) => {
        if (!isStoreConnected) return;
        if (isReconnect || !optimisticEnabled) {
            pendingUpdates.clear();
        }
        setState({ isLoading: true, error: undefined /*, isSyncing: true ? */ }); // isSyncing handled by gap detection now
        const requestId = generateRequestId();
        const queryMessage: ProcedureCallMessage = {
            type: 'query', // Assume initial state comes from a query
            id: requestId,
            path: path, // Use the store's configured path
            input: undefined, // TODO: How to pass input for initial state query? Add option?
        };
        try {
            const resultMessage = await transport.request(queryMessage);
            if (resultMessage.result.type === 'data') {
                console.log(`[ReqDelta - Needs Rework] Received initial state for path "${path}".`);
                pendingUpdates.clear(); // Clear pending on successful refresh
                const initialStateData = resultMessage.result.data as State; // Assume result is State
                const clonedInitial = cloneState(initialStateData);
                if (clonedInitial === undefined && initialStateData !== undefined) {
                    throw new Error("Failed to clone initial state");
                }
                const finalInitialState = clonedInitial ?? initialState; // Ensure non-undefined
                setState({
                    isLoading: false,
                    confirmedState: initialStateData,
                    optimisticState: finalInitialState,
                    error: undefined,
                    lastServerSeq: 0, // Reset sequence
                    isSyncing: false,
                });
            } else {
                // Error result
                throw new Error(resultMessage.result.error.message || 'Failed to fetch initial state');
            }
        } catch (err: any) {
            console.error(`[ReqDelta - Needs Rework] Error fetching initial state for path "${path}":`, err);
            setState({ isLoading: false, error: err.message || err, confirmedState: undefined, isSyncing: false });
        }
    };

    // Subscribe using the new transport interface
    const subscribeToUpdates = () => {
        if (!isStoreConnected || !internalState.isConnected) return;
        if (unsubscribeFn) {
            console.warn(`[ReqDelta - Needs Rework] Already subscribed to path "${path}". Skipping.`);
            return; // Already subscribed
        }
        console.log(`[ReqDelta - Needs Rework] Subscribing to path "${path}"...`);
        const subscribeId = generateRequestId();
        // TODO: How to pass input for subscription? Add option?
        const subscribeMsg: SubscribeMessage = { type: 'subscription', id: subscribeId, path: path /* input: ??? */ };

        const handlers: SubscriptionHandlers = {
            onData: handleSubscriptionData,
            onError: handleSubscriptionError,
            onEnd: handleSubscriptionEnd,
        };

        try {
            unsubscribeFn = transport.subscribe(subscribeMsg, handlers);
        } catch (err: any) {
            console.error(`[ReqDelta - Needs Rework] Error initiating subscription for path "${path}":`, err);
            setState({ isLoading: false, error: err.message || err });
        }
    };

    // Unsubscribe using the stored function from transport.subscribe
    const unsubscribeFromUpdates = () => {
        if (unsubscribeFn) {
            console.log(`[ReqDelta - Needs Rework] Unsubscribing from path "${path}"...`);
            try {
                unsubscribeFn();
            } catch (err) {
                console.warn(`[ReqDelta - Needs Rework] Error during unsubscribe call:`, err);
            }
            unsubscribeFn = undefined;
        }
    };

    // TODO: Rework requestMissingUpdates for TypeQL (if applicable)
    // const requestMissingUpdates = (from: number, to: number) => { ... };

    // --- Store API Implementation (Needs Rework for Optimistic Updates) ---

    // TODO: Rework performOperation for TypeQL mutation model
    const performOperation = (operation: Operation): number => {
        if (!isStoreConnected) {
            console.error("[ReqDelta - Needs Rework] Cannot perform operation: Store is disconnected.");
            return -1;
        }
        if (!internalState.isConnected) {
            console.error("[ReqDelta - Needs Rework] Cannot perform operation: Transport is disconnected.");
            return -1;
        }
        // Use renamed option
        if (!optimisticEnabled || !operationToOptimisticData /* || !clientSeqManager */) {
            console.warn("[ReqDelta - Needs Rework] Optimistic updates not enabled or configured. Operation ignored:", operation);
            return -1;
        }
        // internalState.optimisticState is guaranteed to be State
        const currentOptimisticState = internalState.optimisticState;

        let optimisticData: Delta | null; // Renamed from delta
        try {
            // Use renamed function
            optimisticData = operationToOptimisticData(operation, currentOptimisticState);
        } catch (err) {
            console.error("[ReqDelta - Needs Rework] Error converting operation to optimistic data:", err);
            setState({ error: new Error(`Failed to process operation: ${err}`) });
            return -1;
        }

        if (optimisticData === null) {
            console.log("[ReqDelta - Needs Rework] operationToOptimisticData returned null, operation skipped:", operation);
            return -1;
        }

        const clientSeq = ++clientSeqCounter; // Use temporary counter
        const clonedSnapshot: State | undefined = cloneState(currentOptimisticState);
        if (clonedSnapshot === undefined) {
             console.error("[ReqDelta - Needs Rework] Failed to clone state for snapshot. Cannot apply optimistic update.");
             return -1;
        }
        const snapshot: State = clonedSnapshot; // Now State type

        let newOptimisticState: State;
        try {
            // Use renamed function
            newOptimisticState = applyUpdate(currentOptimisticState, optimisticData);
             if (newOptimisticState === undefined) { // Should not happen
                 throw new Error("applyUpdate returned undefined for optimistic update");
             }
        } catch (err) {
            console.error("[ReqDelta - Needs Rework] Error applying optimistic data:", err);
            setState({ error: new Error(`Failed to apply optimistic update ${clientSeq}: ${err}`) });
            return -1;
        }

        // Store pending update (structure might need change)
        const pending: PendingUpdate<State, Delta, Operation> = {
             operation,
             delta: optimisticData, // Store the generated data/delta
             snapshot,
             timestamp: Date.now(),
             clientSeq // Use temporary counter
        };
        pendingUpdates.set(clientSeq, pending);
        setState({ optimisticState: newOptimisticState, error: undefined });

        // TODO: Send mutation to server using transport.request
        // Needs rework: map operation/optimisticData to the correct mutation path and input
        console.warn("[ReqDelta - Needs Rework] performOperation needs rework to send mutation via transport.request.");
        /*
        const mutationMsg: ProcedureCallMessage = {
            type: 'mutation',
            id: generateRequestId(),
            path: ???, // Mutation path related to the operation
            input: ???, // Input derived from operation/optimisticData
        };
        transport.request(mutationMsg).then(handleMutationResult).catch(handleMutationError);
        */

        return clientSeq; // Return temporary client sequence
    };

    // --- Initialization ---
    // Replace onMessage with subscribe
    // cleanupTransportOnMessage = transport.onMessage(handleIncomingMessage);
    if (transport.onConnectionChange) {
        cleanupTransportOnConnection = transport.onConnectionChange(updateConnectionStatus);
    }
    if (internalState.isConnected) {
        requestInitialState(); // Fetch initial state via query
        subscribeToUpdates(); // Subscribe using transport.subscribe
    } else {
        console.warn(`[ReqDelta - Needs Rework] Transport initially disconnected for path "${path}". Waiting for connection.`);
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
            if (isStoreConnected && internalState.isConnected) {
                 requestInitialState(); // Re-fetch initial state
            } else {
                console.warn(`[ReqDelta - Needs Rework] Cannot refresh store for path "${path}" as it is disconnected.`);
            }
        },
        disconnect: () => {
            if (!isStoreConnected) return;
            isStoreConnected = false;
            unsubscribeFromUpdates(); // Use new unsubscribe logic
            // Clean up connection listener
             if (typeof cleanupTransportOnConnection === 'function') cleanupTransportOnConnection();
             listeners.clear();
             pendingUpdates.clear(); // Clear pending updates

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
                  isConnected: false, // Reflect disconnect
                  isSyncing: false, // Ensure only one isSyncing property
                  syncTargetSeq: -1,
             });
             console.log(`[ReqDelta - Needs Rework] Store disconnected for path "${path}".`);
        },
        performOperation, // Keep API, implementation needs major rework
    };

    return storeApi;
}
