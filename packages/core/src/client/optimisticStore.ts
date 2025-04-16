// packages/core/src/client/optimisticStore.ts

import { produce, applyPatches, Patch } from 'immer';
import type { ProcedureCallMessage, SubscriptionDataMessage, AckMessage } from '../core/types';
import { createClientSequenceManager, ClientSequenceManager } from '../core/seqManager';
// Import conflict resolution types and result structure
import {
    ConflictResolverConfig,
    resolveConflict,
    ConflictResolutionResult, // Import the result type
    ConflictResolutionOutcome // Import the outcome enum/type
} from './conflictResolver';

// --- JSON Patch Types (RFC 6902) ---
/** Represents a single JSON Patch operation. */
interface JsonPatchOperation {
    op: 'add' | 'replace' | 'remove' | 'move' | 'copy' | 'test';
    path: string; // JSON Pointer string (e.g., "/foo/bar/0")
    value?: any; // Value for add/replace/test
    from?: string; // Source path for move/copy
}
/** Represents a sequence of JSON Patch operations. */
type JsonPatch = JsonPatchOperation[];
// --- End JSON Patch Types ---

// --- Immer Patch to JSON Patch Conversion ---

/** Converts an Immer path array to a JSON Pointer string. */
function immerPathToJsonPointer(path: (string | number)[]): string {
    if (path.length === 0) return '';
    // Escape '/' as '~1' and '~' as '~0' according to RFC 6901
    return '/' + path.map(segment => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/**
 * Converts an array of Immer patches to an array of JSON Patch operations.
 * Note: This is a basic conversion and might not handle all edge cases or complex Immer patches perfectly.
 * It currently only supports 'add', 'replace', and 'remove' ops.
 */
function convertImmerPatchesToJsonPatches(immerPatches: Patch[]): JsonPatch {
    return immerPatches.map(patch => {
        const jsonPointerPath = immerPathToJsonPointer(patch.path);
        switch (patch.op) {
            case 'add':
            case 'replace':
                // Ensure value is included for add/replace
                return { op: patch.op, path: jsonPointerPath, value: patch.value };
            case 'remove':
                // Value should not be included for remove
                return { op: patch.op, path: jsonPointerPath };
            // Immer's default patch generation doesn't typically produce 'move', 'copy', 'test'
            default:
                console.warn(`[Optimistic Store] Unsupported Immer patch op ('${(patch as any).op}') for JSON Patch conversion.`);
                return null; // Represent unsupported ops as null
        }
    // Filter out nulls resulting from unsupported ops. TS infers the correct type.
    }).filter(op => op !== null);
}
// --- End Conversion ---

/** Interface for applying deltas to state. */
export interface DeltaApplicator<TState, Delta = any> {
    /**
     * Applies a delta to the given state.
     * Should return the new state or undefined if the delta is invalid or cannot be applied.
     * Implementations should ideally handle immutability.
     */
    applyDelta: (state: TState, delta: Delta) => TState | undefined;
}

// Type for a predicted change from onMutate, could be a delta or a state mutation function
export type PredictedChange<TState> = Patch[] | ((state: TState) => TState | void); // Immer patch or recipe

/** Structure for errors reported by the OptimisticStore. */
export interface OptimisticStoreError {
    type: 'ListenerError' | 'GapRequestError' | 'ConflictResolutionError' | 'ApplyDeltaError' | 'RecomputationError' | 'TimeoutError' | 'RejectionError' | 'PruningError' | 'ProduceError';
    message: string;
    originalError?: any;
    context?: any; // e.g., clientSeq, serverSeq
}

/** Options for creating the optimistic store. */
export interface OptimisticStoreOptions<TState, Delta = any> { // Add Delta generic
    /** Initial state of the store. */
    initialState: TState;
    /** An object implementing the DeltaApplicator interface. */
    deltaApplicator: DeltaApplicator<TState, Delta>;
    /** Optional: Configuration for conflict resolution. Defaults to 'server-wins'. */
    conflictResolverConfig?: ConflictResolverConfig<Delta>; // Use Delta generic
    /** Optional: Maximum number of pending mutations to keep. Defaults to 50. */
    maxPendingMutations?: number;
    /** Optional: Timeout in milliseconds for pending mutations. Defaults to 15000 (15s). */
    mutationTimeoutMs?: number;
    /** Optional: Function to call when a sequence gap is detected, usually linked to the transport. */
    requestMissingDeltas?: (subscriptionId: number | string, fromSeq: number, toSeq: number) => void | Promise<void>;
    /** Optional: Callback for handling internal store errors. */
    onError?: (error: OptimisticStoreError) => void;
}


/** Represents a mutation pending confirmation from the server. */
// Mark TState as unused if PendingMutation doesn't actually depend on it structurally
interface PendingMutation</* TState */> {
    /** Client-generated sequence number. */
    clientSeq: number;
    /** Original mutation call message sent to the server. */
    message: ProcedureCallMessage;
    /** The predicted change applied optimistically (Immer patches for rollback). */
    predictedPatches: Patch[];
    // inversePatches removed
    /** Timestamp when the mutation was initiated. */
    timestamp: number;
    /** Number of times this mutation has been potentially reapplied after rollback. */
    reapplyCount?: number;
    /** ID of the timeout timer for this mutation */
    timeoutTimer?: ReturnType<typeof setTimeout>;
    /** The server sequence number of the confirmed state when this mutation was predicted. */
    confirmedServerSeqAtPrediction: number;
}

/** Callback function for store state changes. */
export type StoreListener<TState> = (optimisticState: TState, confirmedState: TState) => void;

/** Unsubscribe function returned by subscribe. */
export type UnsubscribeStoreListener = () => void;


/** Interface for the optimistic store instance. */
export interface OptimisticStore<TState> {
    /** Get the current optimistic state (reflects pending mutations). */
    getOptimisticState: () => TState;
    /** Get the last confirmed state received from the server. */
    getConfirmedState: () => TState;
    /** Get the server sequence number of the last confirmed state. */
    getConfirmedServerSeq: () => number;
    /** Get the list of currently pending mutations. */
    getPendingMutations: () => Readonly<PendingMutation[]>; // Removed TState generic here

    /**
     * Initiates an optimistic mutation.
     * Applies the predicted change locally and adds the mutation to the pending queue.
     * @param message The mutation call message to be sent to the server (must include clientSeq).
     * @param predictedChange The predicted state change (Immer recipe or patches).
     * @returns The generated client sequence number for this mutation.
     * @throws If clientSeq is missing in the message.
     */
    addPendingMutation: (message: ProcedureCallMessage, predictedChange: PredictedChange<TState>) => number;

    /**
     * Confirms a pending mutation based on a server acknowledgement.
     * Removes the mutation from the pending queue and updates the confirmed state if needed.
     * @param ack The acknowledgement message from the server.
     */
    confirmPendingMutation: (ack: AckMessage) => void;

    /**
     * Applies a confirmed delta update from the server.
     * Updates the confirmed state, handles potential sequence gaps,
     * and reconciles the optimistic state by rolling back and reapplying pending mutations.
     * @param deltaMessage The subscription data message containing the delta and serverSeq.
     */
    applyServerDelta: (deltaMessage: SubscriptionDataMessage) => void;

    /**
     * Rejects a pending mutation, typically due to a server error response.
     * Rolls back the rejected mutation and potentially subsequent ones.
     * @param clientSeq The client sequence number of the rejected mutation.
     * @param error Optional error information from the server.
     */
    rejectPendingMutation: (clientSeq: number, error?: any) => void;

    /**
     * Subscribes a listener function to store changes.
     * @param listener The function to call when the state changes.
     * @returns A function to unsubscribe the listener.
     */
    subscribe: (listener: StoreListener<TState>) => UnsubscribeStoreListener;

    // TODO: Add methods for handling server rejection of mutations
    // Interface method is defined, implementation needs connection to requestMissingDeltas option.
    // TODO: Add methods for timeout handling and cleanup
}

/**
 * Creates an optimistic store instance.
 * Manages confirmed and optimistic states, pending mutations, and reconciliation logic.
 */
export function createOptimisticStore<TState, Delta = JsonPatch>( // Default Delta to JsonPatch
    options: OptimisticStoreOptions<TState, Delta> // Use generic options
): OptimisticStore<TState> {
    const {
        initialState,
        deltaApplicator, // Use the applicator object
        // Default conflict strategy to 'server-wins'
        conflictResolverConfig = { strategy: 'server-wins' } as ConflictResolverConfig<Delta>,
        maxPendingMutations = 50,
        mutationTimeoutMs = 15000,
        // requestMissingDeltas is used below, keep it
        requestMissingDeltas,
        onError, // Add onError callback
    } = options;

    let confirmedState: TState = initialState;
    let optimisticState: TState = initialState;
    let confirmedServerSeq: number = 0; // Track the sequence number of the confirmed state
    let pendingMutations: PendingMutation[] = []; // Removed TState generic here
    const clientSeqManager: ClientSequenceManager = createClientSequenceManager();
    const listeners = new Set<StoreListener<TState>>();
    const effectiveMutationTimeoutMs = mutationTimeoutMs > 0 ? mutationTimeoutMs : 0; // Ensure it's non-negative

    /** Helper to report errors via console and optional callback */
    const reportError = (errorInfo: OptimisticStoreError) => {
        console.error(`[Optimistic Store Error - ${errorInfo.type}]: ${errorInfo.message}`, errorInfo.originalError ?? '', errorInfo.context ?? '');
        if (onError) {
            try {
                onError(errorInfo);
            } catch (callbackError) {
                console.error("[Optimistic Store] Error calling onError callback:", callbackError);
            }
        }
    };

    /** Helper to report warnings via console and optional callback */
    const reportWarning = (type: OptimisticStoreError['type'], message: string, context?: any) => {
        console.warn(`[Optimistic Store Warning - ${type}]: ${message}`, context ?? '');
        if (onError) {
            try {
                // Pass warnings as errors too, allowing unified handling
                onError({ type, message, context });
            } catch (callbackError) {
                console.error("[Optimistic Store] Error calling onError callback for warning:", callbackError);
            }
        }
    };

    const getOptimisticState = (): TState => optimisticState;
    const getConfirmedState = (): TState => confirmedState;
    const getConfirmedServerSeq = (): number => confirmedServerSeq;
    const getPendingMutations = (): Readonly<PendingMutation[]> => pendingMutations; // Removed TState generic here

    /** Notifies all registered listeners about a state change. */
    const notifyListeners = () => {
        console.debug(`[Optimistic Store] Notifying ${listeners.size} listeners.`);
        listeners.forEach(listener => {
            try {
                 listener(optimisticState, confirmedState);
            } catch (error) {
                reportError({
                    type: 'ListenerError',
                    message: 'Error in store listener execution.',
                    originalError: error
                });
            }
        });
    };

    /** Recomputes optimistic state from confirmed state + pending mutations */
    const recomputeOptimisticState = () => {
        try {
            optimisticState = produce(confirmedState, (draft: TState) => { // Add draft type
                pendingMutations.forEach(mutation => {
                    // Ensure draft is not accidentally mutated if applyPatches doesn't return void
                    const tempDraft: any = draft; // Use 'any' temporarily if Immer's types clash
                    applyPatches(tempDraft, mutation.predictedPatches);
                });
            });
        } catch (error) {
            reportError({
                type: 'RecomputationError',
                message: 'Error applying pending mutations during recomputation.',
                originalError: error,
            });
            // If recompute fails, the optimistic state might be corrupt. Resetting might be safest.
            optimisticState = confirmedState; // Reset optimistic to last known good confirmed state
            // Keep remaining pending mutations? Or clear them? Clearing seems safer if recompute failed.
            pendingMutations.forEach(m => { if (m.timeoutTimer) clearTimeout(m.timeoutTimer); }); // Clear timers
            pendingMutations = [];
            // Notify listeners about the reset state AFTER resetting
            notifyListeners();
            return; // Exit early as state was reset
        }
        // Notify listeners AFTER successful recomputation
        notifyListeners();
        console.log("[Optimistic Store] Recomputed optimistic state and notified listeners.");
    };


    /** Handles timeout for a specific pending mutation */
    const handleMutationTimeout = (clientSeq: number) => {
        const message = `Mutation (clientSeq: ${clientSeq}) timed out after ${effectiveMutationTimeoutMs}ms.`;
        // Report as an error via the callback, but log as warning
        console.warn(`[Optimistic Store Warning - TimeoutError]: ${message}`, { clientSeq, durationMs: effectiveMutationTimeoutMs });
        if (onError) {
             try {
                 onError({ type: 'TimeoutError', message, context: { clientSeq, durationMs: effectiveMutationTimeoutMs } });
             } catch (callbackError) {
                 console.error("[Optimistic Store] Error calling onError callback for timeout:", callbackError);
             }
        }
        // Reject the mutation
        rejectPendingMutation(clientSeq, { reason: 'timeout', durationMs: effectiveMutationTimeoutMs });
        // No need to recompute state here, rejectPendingMutation handles it
    };


    const addPendingMutation = (message: ProcedureCallMessage, predictedChange: PredictedChange<TState>): number => {
        const clientSeq = message.clientSeq ?? clientSeqManager.getNext(); // Use provided or generate next
        if (message.clientSeq === undefined) {
             // This should ideally be handled by the caller ensuring clientSeq exists
             throw new Error("ProcedureCallMessage must include clientSeq for optimistic mutation.");
        }

        console.log(`[Optimistic Store] Adding pending mutation with clientSeq: ${clientSeq}`);

        let predictedPatches: Patch[] = [];

        // Apply the predicted change optimistically using Immer
        try {
            optimisticState = produce(
                optimisticState,
                (draft: TState) => { // Add draft type
                    if (typeof predictedChange === 'function') {
                        predictedChange(draft); // Apply Immer recipe
                    } else {
                        // Ensure draft is not accidentally mutated if applyPatches doesn't return void
                        const tempDraft: any = draft; // Use 'any' temporarily if Immer's types clash
                        applyPatches(tempDraft, predictedChange); // Apply pre-calculated patches
                    }
                },
                (patches: Patch[] /*, invPatches: Patch[] */) => { // Comment out unused invPatches
                    predictedPatches = patches;
                }
            );
        } catch (error) {
            reportError({
                type: 'ProduceError',
                message: 'Error applying predicted change using Immer.',
                originalError: error,
                context: { clientSeq }
            });
            // If produce fails, don't add the pending mutation
            return clientSeq; // Return the seq, but the mutation wasn't added/applied
        }

        const newPending: PendingMutation = { // Removed TState generic here
            clientSeq,
            message,
            predictedPatches,
            timestamp: Date.now(),
            confirmedServerSeqAtPrediction: confirmedServerSeq, // Record current confirmed seq
            // timeoutTimer will be set below
        };

        // Set timeout if configured
        if (effectiveMutationTimeoutMs > 0) {
            newPending.timeoutTimer = setTimeout(() => handleMutationTimeout(clientSeq), effectiveMutationTimeoutMs);
        }

        pendingMutations.push(newPending);

        // Prune old mutations if queue exceeds max size
        if (pendingMutations.length > maxPendingMutations) {
            const removed = pendingMutations.shift(); // Remove the oldest
            if (removed) {
                if (removed.timeoutTimer) {
                    clearTimeout(removed.timeoutTimer); // Clear timeout for pruned mutation
                }
                reportWarning(
                    'PruningError',
                    `Pending mutation queue exceeded ${maxPendingMutations}. Removed oldest mutation.`,
                    { clientSeq: removed.clientSeq, maxQueueSize: maxPendingMutations }
                );
            }
         }

         // Notify listeners about the optimistic state change (after potential pruning)
         notifyListeners();
         console.log("[Optimistic Store] Optimistic state updated and notified listeners.");

         return clientSeq;
    };

    const confirmPendingMutation = (ack: AckMessage) => {
        const { clientSeq, serverSeq } = ack;
        const index = pendingMutations.findIndex(p => p.clientSeq === clientSeq);

        if (index === -1) {
            reportWarning('RejectionError', 'Received confirmation for unknown or already confirmed mutation.', { clientSeq });
            return;
        }

        console.log(`[Optimistic Store] Confirming mutation (clientSeq: ${clientSeq}, serverSeq: ${serverSeq}).`);

        // Clear timeout for the confirmed mutation and any older ones being removed
        const mutationsBeingRemoved = pendingMutations.slice(0, index + 1);
        mutationsBeingRemoved.forEach(m => {
            if (m.timeoutTimer) clearTimeout(m.timeoutTimer);
        });

        // Remove the confirmed mutation and any older ones (as they are now implicitly confirmed by sequence)
        pendingMutations = pendingMutations.slice(index + 1);

        // Update the confirmed server sequence number ONLY.
        if (serverSeq > confirmedServerSeq) {
             confirmedServerSeq = serverSeq;
             console.log(`[Optimistic Store] Confirmed server sequence updated to: ${serverSeq}.`);
        } else {
            reportWarning('RejectionError', 'Received ack with older/equal serverSeq.', { clientSeq, ackServerSeq: serverSeq, currentConfirmedSeq: confirmedServerSeq });
        }

        // Optimistic state needs recomputing because pending mutations were removed
        recomputeOptimisticState();
     };

     const applyServerDelta = (deltaMessage: SubscriptionDataMessage) => {
         const { data: delta, serverSeq, prevServerSeq } = deltaMessage;

        console.log(`[Optimistic Store] Applying server delta (serverSeq: ${serverSeq}, prevServerSeq: ${prevServerSeq ?? 'N/A'}). Current confirmedSeq: ${confirmedServerSeq}`);

         // 1. Check for sequence gaps
        if (prevServerSeq !== undefined && prevServerSeq !== confirmedServerSeq) {
            const message = `Sequence gap detected! Expected prev ${confirmedServerSeq}, got ${prevServerSeq}. Requesting missing updates...`;
            reportWarning('GapRequestError', message, { expectedPrevSeq: confirmedServerSeq, receivedPrevSeq: prevServerSeq, currentServerSeq: serverSeq });

            // Call the provided callback to request missing deltas
            if (requestMissingDeltas) {
                 try {
                    // Request range from the sequence after the last confirmed up to the sequence received
                    void requestMissingDeltas(deltaMessage.id, confirmedServerSeq + 1, serverSeq);
                 } catch (requestError) {
                    reportError({
                        type: 'GapRequestError',
                        message: 'Error calling requestMissingDeltas function.',
                        originalError: requestError,
                        context: { fromSeq: confirmedServerSeq + 1, toSeq: serverSeq }
                    });
                 }
            } else {
                reportWarning('GapRequestError', 'Sequence gap detected, but no requestMissingDeltas function provided.');
            }

            // Still ignore the current delta to prevent applying it out of order
            return;
        }

        // 2. Check for conflicts with pending mutations before applying delta
        const conflictingMutations = pendingMutations.filter(p =>
            prevServerSeq !== undefined && p.confirmedServerSeqAtPrediction < prevServerSeq
        );

        let resolvedDelta = delta;
        // Initialize with a valid outcome type or handle 'no-conflict' case separately
        let resolutionOutcome: ConflictResolutionOutcome | 'error' | 'no-conflict' = 'no-conflict'; // Track outcome

        if (conflictingMutations.length > 0) {
            reportWarning('ConflictResolutionError', `Conflict detected with ${conflictingMutations.length} pending mutation(s).`, { serverSeq, prevServerSeq, conflictingClientSeqs: conflictingMutations.map(m => m.clientSeq) });

            // --- Conflict Resolution Logic ---
            let clientDeltaForConflict: Delta | undefined = undefined;
            try {
                // 1. Extract Client Delta
                const allClientImmerPatches: Patch[] = conflictingMutations.reduce(
                    (acc, mutation) => acc.concat(mutation.predictedPatches),
                    [] as Patch[]
                );
                const clientJsonPatches = convertImmerPatchesToJsonPatches(allClientImmerPatches);
                clientDeltaForConflict = clientJsonPatches as unknown as Delta;

                // 2. Call Resolver
                console.log(`[Optimistic Store] Resolving conflict with strategy: ${conflictResolverConfig.strategy}`);
                const serverDeltaForConflict = delta as Delta;
                const conflictResult: ConflictResolutionResult<Delta> = resolveConflict<Delta>(
                    clientDeltaForConflict,
                    serverDeltaForConflict,
                    conflictResolverConfig
                );
                resolvedDelta = conflictResult.resolvedDelta;
                resolutionOutcome = conflictResult.outcome; // Assign outcome here
                console.log(`[Optimistic Store] Conflict resolved with outcome: ${resolutionOutcome}. Using resulting delta.`);

            } catch (resolutionError) {
                reportError({
                    type: 'ConflictResolutionError',
                    message: 'Error executing conflict resolver.',
                    originalError: resolutionError,
                    context: { serverSeq, clientDelta: clientDeltaForConflict, serverDelta: delta }
                });
                // Default to server-wins on resolver error
                resolvedDelta = delta;
                resolutionOutcome = 'error'; // Set specific outcome for error
            }
            // --- End Conflict Resolution Logic ---

            // --- Post-Resolution Handling ---
            if (resolutionOutcome === 'client-applied' || resolutionOutcome === 'merged') {
                console.log(`[Optimistic Store] Outcome is '${resolutionOutcome}'. Removing ${conflictingMutations.length} conflicting mutations from pending list.`);
                const conflictingClientSeqs = new Set(conflictingMutations.map(m => m.clientSeq));
                pendingMutations = pendingMutations.filter(p => !conflictingClientSeqs.has(p.clientSeq));
                conflictingMutations.forEach(m => {
                    if (m.timeoutTimer) clearTimeout(m.timeoutTimer);
                });
            }
            // If outcome is 'server-applied' or 'error', conflicting mutations remain pending.
            // --- End Post-Resolution Handling ---
        }


        // 3. Apply the resolved delta to confirmed state
        try {
            // Use the applyDelta method from the applicator
            const nextConfirmedState = deltaApplicator.applyDelta(confirmedState, resolvedDelta as Delta);
             if (nextConfirmedState !== undefined) {
                 // No need to check stateChanged, produce handles structural sharing
                 confirmedState = nextConfirmedState;
                 confirmedServerSeq = serverSeq; // Update confirmed sequence number
                 console.log(`[Optimistic Store] Confirmed state updated by delta to serverSeq: ${serverSeq}.`);
             } else {
                reportWarning('ApplyDeltaError', 'deltaApplicator.applyDelta returned undefined.', { serverSeq });
            }
        } catch (error) {
            reportError({
                type: 'ApplyDeltaError',
                message: 'Error applying server delta to confirmed state.',
                originalError: error,
                context: { serverSeq }
            });
            // If applyDeltaFn fails, confirmed state is potentially corrupt.
            // Recomputation will happen anyway, based on the potentially corrupt state.
        }


        // 4. Reconcile optimistic state (this also notifies listeners)
         recomputeOptimisticState();
     };

     const subscribe = (listener: StoreListener<TState>): UnsubscribeStoreListener => {
         listeners.add(listener);
         return () => {
             listeners.delete(listener);
         };
     };

    const rejectPendingMutation = (clientSeq: number, error?: any) => {
        const index = pendingMutations.findIndex(p => p.clientSeq === clientSeq);

        if (index === -1) {
            // Don't report error if already handled by timeout
            if (!(error && error.reason === 'timeout')) {
                 reportWarning('RejectionError', 'Received rejection for unknown or already resolved mutation.', { clientSeq });
            }
            return;
        }

        // Report error only if not triggered by timeout (timeout reports its own error)
        if (!(error && error.reason === 'timeout')) {
            reportError({
                type: 'RejectionError',
                message: `Rejecting mutation due to server response or manual call.`,
                originalError: error,
                context: { clientSeq }
            });
        }

        const rejectedMutation = pendingMutations[index];
        const subsequentMutations = pendingMutations.slice(index + 1);

        if (rejectedMutation) {
            if (rejectedMutation.timeoutTimer) clearTimeout(rejectedMutation.timeoutTimer);
            console.log(`[Optimistic Store] Rolling back rejected mutation ${rejectedMutation.clientSeq} and ${subsequentMutations.length} subsequent pending mutations.`);
            subsequentMutations.forEach(m => {
                if (m.timeoutTimer) clearTimeout(m.timeoutTimer);
            });
        } else {
            // This should theoretically not happen
            reportError({
                type: 'RejectionError',
                message: 'Internal inconsistency: Could not find rejected mutation after initial check.',
                context: { clientSeq, index }
            });
        }

        pendingMutations = pendingMutations.slice(0, index); // Keep only mutations before the rejected one

        // Recompute optimistic state based on the remaining pending mutations
        recomputeOptimisticState();
    };


     // TODO: Implement timeout checks for pending mutations (partially done via setTimeout)

     return {
         getOptimisticState,
        getConfirmedState,
        getConfirmedServerSeq,
        getPendingMutations,
        addPendingMutation,
         confirmPendingMutation,
         rejectPendingMutation, // Expose rejection method
         applyServerDelta,
         subscribe, // Expose subscribe method
     };
 }

console.log("packages/core/src/client/optimisticStore.ts loaded");
