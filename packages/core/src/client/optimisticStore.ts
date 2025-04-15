// packages/core/src/client/optimisticStore.ts

import { produce, applyPatches, Patch } from 'immer';
import type { ProcedureCallMessage, SubscriptionDataMessage, AckMessage } from '../core/types';
import { createClientSequenceManager, ClientSequenceManager } from '../core/seqManager';

// Type for a function that applies a delta (could be standard or custom)
// TODO: Define a standard delta application interface/type
export type ApplyDeltaFn<TState> = (state: TState, delta: any) => TState | undefined; // Also export this

// Type for a predicted change from onMutate, could be a delta or a state mutation function
export type PredictedChange<TState> = Patch[] | ((state: TState) => TState | void); // Immer patch or recipe

/** Represents a mutation pending confirmation from the server. */
interface PendingMutation<TState> {
    /** Client-generated sequence number. */
    clientSeq: number;
    /** Original mutation call message sent to the server. */
    message: ProcedureCallMessage;
    /** The predicted change applied optimistically (Immer patches for rollback). */
    predictedPatches: Patch[];
    /** Inverse patches to revert the optimistic change. */
    inversePatches: Patch[];
    /** Timestamp when the mutation was initiated. */
    timestamp: number;
    /** Number of times this mutation has been potentially reapplied after rollback. */
    reapplyCount?: number;
    /** ID of the timeout timer for this mutation */
    timeoutTimer?: ReturnType<typeof setTimeout>;
}

/** Options for creating the optimistic store. */
export interface OptimisticStoreOptions<TState> {
    /** Initial state of the store. */
    initialState: TState;
    /** Function to apply server deltas to the state. */
    applyDelta: ApplyDeltaFn<TState>;
    /** Optional: Maximum number of pending mutations to keep. Defaults to 50. */
    maxPendingMutations?: number;
    /** Optional: Timeout in milliseconds for pending mutations. Defaults to 15000 (15s). */
    mutationTimeoutMs?: number;
    /** Optional: Function to call when a sequence gap is detected, usually linked to the transport. */
    requestMissingDeltas?: (subscriptionId: number | string, fromSeq: number, toSeq: number) => void | Promise<void>;
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
    getPendingMutations: () => Readonly<PendingMutation<TState>[]>;

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
export function createOptimisticStore<TState>(
    options: OptimisticStoreOptions<TState>
): OptimisticStore<TState> {
    const {
        initialState,
        applyDelta: applyDeltaFn,
        maxPendingMutations = 50,
        mutationTimeoutMs = 15000,
        requestMissingDeltas, // Destructure the new option
    } = options;

    let confirmedState: TState = initialState;
    let optimisticState: TState = initialState;
    let confirmedServerSeq: number = 0; // Track the sequence number of the confirmed state
    let pendingMutations: PendingMutation<TState>[] = [];
    const clientSeqManager: ClientSequenceManager = createClientSequenceManager();
    const listeners = new Set<StoreListener<TState>>();
    const effectiveMutationTimeoutMs = mutationTimeoutMs > 0 ? mutationTimeoutMs : 0; // Ensure it's non-negative

    const getOptimisticState = (): TState => optimisticState;
    const getConfirmedState = (): TState => confirmedState;
    const getConfirmedServerSeq = (): number => confirmedServerSeq;
    const getPendingMutations = (): Readonly<PendingMutation<TState>[]> => pendingMutations;

    /** Recomputes optimistic state from confirmed state + pending mutations */
    const recomputeOptimisticState = () => {
        optimisticState = produce(confirmedState, (draft: TState) => { // Add draft type
            pendingMutations.forEach(mutation => {
                // Ensure draft is not accidentally mutated if applyPatches doesn't return void
                const tempDraft: any = draft; // Use 'any' temporarily if Immer's types clash
                applyPatches(tempDraft, mutation.predictedPatches);
            });
        });
        notifyListeners(); // Notify after recomputing optimistic state
        console.log("[Optimistic Store] Recomputed optimistic state and notified listeners.");
    };

    /** Notifies all registered listeners about a state change. */
    const notifyListeners = () => {
        console.debug(`[Optimistic Store] Notifying ${listeners.size} listeners.`);
        listeners.forEach(listener => {
            try {
                 listener(optimisticState, confirmedState);
            } catch (error) {
                 console.error("[Optimistic Store] Error in listener:", error);
            }
        });
    };


    /** Handles timeout for a specific pending mutation */
    const handleMutationTimeout = (clientSeq: number) => {
        console.warn(`[Optimistic Store] Mutation (clientSeq: ${clientSeq}) timed out after ${effectiveMutationTimeoutMs}ms.`);
        // Reject the mutation, passing a specific timeout error object
        rejectPendingMutation(clientSeq, { reason: 'timeout', durationMs: effectiveMutationTimeoutMs });
        // No need to recompute state here, rejectPendingMutation handles it
    };


    const addPendingMutation = (message: ProcedureCallMessage, predictedChange: PredictedChange<TState>): number => {
        const clientSeq = message.clientSeq ?? clientSeqManager.getNext(); // Use provided or generate next
        if (message.clientSeq === undefined) {
             // If generating, assign it back? Or assume caller handles this? For now, assume message includes it.
            // message.clientSeq = clientSeq; // Mutating input might be bad practice
            if(message.clientSeq === undefined) {
                 throw new Error("ProcedureCallMessage must include clientSeq for optimistic mutation.");
            }
        }

        console.log(`[Optimistic Store] Adding pending mutation with clientSeq: ${clientSeq}`);

        let predictedPatches: Patch[] = [];
        let inversePatches: Patch[] = [];

        // Apply the predicted change optimistically using Immer
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
            (patches: Patch[], invPatches: Patch[]) => { // Add types for patches
                predictedPatches = patches;
                inversePatches = invPatches;
            }
        );

        const newPending: PendingMutation<TState> = {
            clientSeq,
            message,
            predictedPatches,
            inversePatches,
            timestamp: Date.now(),
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
            if (removed?.timeoutTimer) {
                clearTimeout(removed.timeoutTimer); // Clear timeout for pruned mutation
            }
            console.warn(`[Optimistic Store] Pending mutation queue exceeded ${maxPendingMutations}. Removed oldest mutation (clientSeq: ${removed?.clientSeq}). State reconciliation might be needed.`);
             // If the oldest is removed, recomputation was already triggered when adding the new one
         } else {
             notifyListeners(); // Notify about optimistic state change
             console.log("[Optimistic Store] Optimistic state updated and notified listeners.");
         }

         return clientSeq;
    };

    const confirmPendingMutation = (ack: AckMessage) => {
        const { clientSeq, serverSeq } = ack;
        const index = pendingMutations.findIndex(p => p.clientSeq === clientSeq);

        if (index === -1) {
            console.warn(`[Optimistic Store] Received confirmation for unknown or already confirmed mutation (clientSeq: ${clientSeq}).`);
            return;
        }

        const confirmedMutation = pendingMutations[index];
        console.log(`[Optimistic Store] Confirming mutation (clientSeq: ${clientSeq}, serverSeq: ${serverSeq}).`);

        // Clear timeout for the confirmed mutation and any older ones being removed
        const mutationsBeingRemoved = pendingMutations.slice(0, index + 1);
        mutationsBeingRemoved.forEach(m => {
            if (m.timeoutTimer) clearTimeout(m.timeoutTimer);
        });

        // Remove the confirmed mutation and any older ones (as they are now implicitly confirmed by sequence)
        const mutationsToApplyToConfirmed = mutationsBeingRemoved; // Reuse the slice
        pendingMutations = pendingMutations.slice(index + 1);

        // Apply the newly confirmed mutations to the confirmed state
        try {
            confirmedState = produce(confirmedState, (draft: TState) => { // Add draft type
                mutationsToApplyToConfirmed.forEach(mutation => {
                    // Ensure draft is not accidentally mutated if applyPatches doesn't return void
                     const tempDraft: any = draft; // Use 'any' temporarily if Immer's types clash
                    applyPatches(tempDraft, mutation.predictedPatches);
                 });
             });
             confirmedServerSeq = serverSeq; // Update confirmed sequence number
             console.log(`[Optimistic Store] Confirmed state updated to serverSeq: ${serverSeq}.`);

             // Optimistic state might need recomputing if pending mutations remain
            recomputeOptimisticState();

        } catch (error) {
             console.error(`[Optimistic Store] Error applying confirmed mutations (clientSeq: ${clientSeq}) to confirmed state:`, error);
             // Critical error: State might be inconsistent. Need recovery strategy.
             // Simple strategy: Reset optimistic to confirmed and hope server deltas fix it.
             optimisticState = confirmedState;
             pendingMutations = []; // Clear pending queue as we can't trust it
         } // <<< End of the first catch block
     };

     const applyServerDelta = (deltaMessage: SubscriptionDataMessage) => {
         const { data: delta, serverSeq, prevServerSeq } = deltaMessage;

        console.log(`[Optimistic Store] Applying server delta (serverSeq: ${serverSeq}, prevServerSeq: ${prevServerSeq ?? 'N/A'}). Current confirmedSeq: ${confirmedServerSeq}`);

         // 1. Check for sequence gaps
        if (prevServerSeq !== undefined && prevServerSeq !== confirmedServerSeq) {
            console.warn(`[Optimistic Store] Sequence gap detected! Expected prev ${confirmedServerSeq}, got ${prevServerSeq}. Requesting missing updates...`);

            // Call the provided callback to request missing deltas
            if (options.requestMissingDeltas) {
                 try {
                    // Request range from the sequence after the last confirmed up to the sequence received
                    void options.requestMissingDeltas(deltaMessage.id, confirmedServerSeq + 1, serverSeq);
                 } catch (requestError) {
                     console.error("[Optimistic Store] Error calling requestMissingDeltas:", requestError);
                 }
            } else {
                 console.warn("[Optimistic Store] Sequence gap detected, but no requestMissingDeltas function provided in options.");
            }

            // Still ignore the current delta to prevent applying it out of order
            console.error(`[Optimistic Store] Ignoring delta ${serverSeq} due to sequence gap.`);
            return;
        }

        // 2. Apply delta to confirmed state
        try {
            const nextConfirmedState = applyDeltaFn(confirmedState, delta);
             if (nextConfirmedState !== undefined) {
                 const stateChanged = confirmedState !== nextConfirmedState;
                 confirmedState = nextConfirmedState;
                 confirmedServerSeq = serverSeq; // Update confirmed sequence number
                 if (stateChanged) {
                      // Notify only if confirmed state actually changed
                      // Recomputing optimistic state below will handle notification
                     console.log(`[Optimistic Store] Confirmed state updated by delta to serverSeq: ${serverSeq}.`);
                 }
             } else {
                 console.warn(`[Optimistic Store] applyDelta function returned undefined for delta (serverSeq: ${serverSeq}). Confirmed state not updated.`);
                 // If delta application failed, what should we do? Maybe try reconciliation anyway?
            }
        } catch (error) {
             console.error(`[Optimistic Store] Error applying server delta (serverSeq: ${serverSeq}) to confirmed state:`, error);
             // State might be inconsistent. Log error and potentially try reconciliation.
             // If applyDeltaFn fails, confirmed state is potentially corrupt.
        }


        // 3. Reconcile optimistic state: Rollback and reapply pending mutations
         // 3. Reconcile optimistic state (this also notifies listeners)
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
            console.warn(`[Optimistic Store] Received rejection for unknown or already resolved mutation (clientSeq: ${clientSeq}).`);
            return;
        }

        console.error(`[Optimistic Store] Rejecting mutation (clientSeq: ${clientSeq}). Error:`, error);

        // Simple rollback strategy: Remove the rejected mutation and all subsequent pending mutations.
        // More complex strategies could try to rebase subsequent mutations.
        const rejectedMutation = pendingMutations[index]; // Get the mutation first
        const subsequentMutations = pendingMutations.slice(index + 1);

        // Check if rejectedMutation exists before accessing its properties
        if (rejectedMutation) {
            if (rejectedMutation.timeoutTimer) clearTimeout(rejectedMutation.timeoutTimer); // Clear timer for rejected mutation
            console.log(`[Optimistic Store] Rolling back rejected mutation ${rejectedMutation.clientSeq} and ${subsequentMutations.length} subsequent pending mutations.`);
            // Clear timers for subsequent mutations being removed as well
            subsequentMutations.forEach(m => {
                if (m.timeoutTimer) clearTimeout(m.timeoutTimer);
            });
        } else {
            // This should theoretically not happen due to the index check above, but adds safety
            console.error(`[Optimistic Store] Could not find rejected mutation at index ${index} despite passing initial check.`);
        }


        pendingMutations = pendingMutations.slice(0, index); // Keep only mutations before the rejected one

        // Recompute optimistic state based on the remaining pending mutations
        recomputeOptimisticState();

        // TODO: Optionally notify listeners specifically about the rejection/rollback?
        // The general notification from recomputeOptimisticState might be sufficient.
    };


     // TODO: Implement timeout checks for pending mutations

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
