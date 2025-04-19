// packages/transport-websocket/src/subscription.ts

import type {
    ConnectionState,
    SubscribeMessage,
    SubscriptionResult,
    InternalSubscriptionHandlers,
    ActiveSubscriptionEntry,
    SubscriptionIteratorYield,
    UnsubscribeMessage,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    RequestMissingMessage, // Added missing import
} from './types';
import { connectWebSocket, sendMessage } from './connection';
import { OPEN } from './constants';

/**
 * Handles initiating a subscription and returning an async iterator for results.
 * Manages the subscription lifecycle, message queueing, and cleanup.
 * @param state - The shared connection state.
 * @param message - The subscription request message.
 * @returns An object containing the async iterator and an unsubscribe function.
 */
export function handleSubscribe(
    state: ConnectionState,
    message: SubscribeMessage
): SubscriptionResult {
    const subId = message.id;
    console.log(`[TypeQL WS Transport] Attempting to subscribe (ID: ${subId})`);

    // --- Async Iterator State ---
    let resolveNextPromise: ((value: IteratorResult<SubscriptionIteratorYield>) => void) | null = null;
    let rejectNextPromise: ((reason?: any) => void) | null = null;
    let messageQueue: SubscriptionIteratorYield[] = [];
    let isFinished = false;
    // let isActive = false; // isActive is managed within the subEntry in the state map

    // --- Internal Handlers for Iterator ---
    const handlers: InternalSubscriptionHandlers = {
        onData: (dataMsg: SubscriptionDataMessage) => {
            if (resolveNextPromise) {
                resolveNextPromise({ value: dataMsg, done: false });
                resolveNextPromise = null;
                rejectNextPromise = null;
            } else {
                messageQueue.push(dataMsg);
            }
        },
        onError: (error: SubscriptionErrorMessage['error']) => {
            console.error(`[TypeQL WS Transport] onError called for ${subId}. isFinished=${isFinished}, hasReject=${!!rejectNextPromise}, hasResolve=${!!resolveNextPromise}`, error);
            const result: SubscriptionErrorMessage = { type: 'subscriptionError', id: subId, error };
            isFinished = true;
            // isActive = false; // Managed in subEntry

            if (rejectNextPromise) {
                console.debug(`[TypeQL WS Transport] onError rejecting promise for ${subId}`);
                rejectNextPromise(new Error(error.message || 'Subscription error occurred')); // Wrap error
            } else if (resolveNextPromise) {
                console.debug(`[TypeQL WS Transport] onError resolving promise with error for ${subId}`);
                resolveNextPromise({ value: result, done: false }); // Yield the error message
            } else {
                console.debug(`[TypeQL WS Transport] onError queueing error for ${subId}`);
                messageQueue.push(result);
            }
            // Clean up state map and promises
            state.activeSubscriptions.delete(subId);
            resolveNextPromise = null;
            rejectNextPromise = null;
        },
        onEnd: () => {
            console.log(`[TypeQL WS Transport] onEnd called for ${subId}. isFinished=${isFinished}, hasResolve=${!!resolveNextPromise}`);
            isFinished = true;
            // isActive = false; // Managed in subEntry
            if (resolveNextPromise) {
                resolveNextPromise({ value: undefined, done: true }); // Signal completion
            }
            // Clean up state map and promises
            state.activeSubscriptions.delete(subId);
            resolveNextPromise = null;
            rejectNextPromise = null;
        },
        onStart: () => {
            // isActive = true; // Managed in subEntry
            const subEntry = state.activeSubscriptions.get(subId);
            if (subEntry) {
                subEntry.active = true; // Update the entry in the map
            }
            console.log(`[TypeQL WS Transport] Subscription active (ID: ${subId})`);
        }
    };

    // --- Store Subscription Entry ---
    const subEntry: ActiveSubscriptionEntry = { message, handlers, active: false }; // Start inactive
    state.activeSubscriptions.set(subId, subEntry);

    // --- Connect and Send Logic ---
    const connectAndSendSubscribe = async () => {
        try {
            await (state.connectionPromise || connectWebSocket(state)); // Ensure connection attempt happens
            if (state.ws?.readyState === OPEN) {
                if (sendMessage(state, message)) {
                    // Don't mark active here, wait for onStart or first data
                    console.log(`[TypeQL WS Transport] Subscribe message sent (ID: ${subId})`);
                } else {
                    throw new Error("Failed to send subscribe message");
                }
            } else {
                console.warn(`[TypeQL WS Transport] WebSocket not open after connect attempt for subscription ${subId}. Will retry on reconnect.`);
                // Mark as inactive so reconnect logic picks it up
                subEntry.active = false;
            }
        } catch (err: any) {
            console.error(`[TypeQL WS Transport] Error during initial subscribe connection/send (ID: ${subId}):`, err);
            // Use the onError handler to manage iterator state and cleanup
            handlers.onError({ message: `Subscription failed: ${err.message || err}` });
        }
    };

    // Start the connection/sending process asynchronously
    connectAndSendSubscribe();

    // --- Unsubscribe Function ---
    const unsubscribe: UnsubscribeFn = () => {
        const currentSub = state.activeSubscriptions.get(subId);
        if (currentSub) {
            console.log(`[TypeQL WS Transport] Unsubscribing (ID: ${subId})`);

            // Signal iterator completion if not already finished
            // This also handles removing from activeSubscriptions map via onEnd handler
            if (!isFinished) {
                handlers.onEnd();
            }
            // Note: handlers.onEnd() already deletes from activeSubscriptions

            // Attempt to send stop message only if connection is open
            if (state.ws?.readyState === OPEN) {
                const unsubscribeMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: subId };
                sendMessage(state, unsubscribeMessage);
            }
        } else {
            console.log(`[TypeQL WS Transport] Unsubscribe called for already inactive/finished subscription (ID: ${subId})`);
        }
    };


    // --- Async Iterator Implementation ---
    const iterator: AsyncIterableIterator<SubscriptionIteratorYield> = {
        async next(): Promise<IteratorResult<SubscriptionIteratorYield>> {
            if (messageQueue.length > 0) {
                return { value: messageQueue.shift()!, done: false };
            }
            if (isFinished) {
                return { value: undefined, done: true };
            }
            // Wait for the next message or completion/error
            return new Promise<IteratorResult<SubscriptionIteratorYield>>((resolve, reject) => {
                resolveNextPromise = resolve;
                rejectNextPromise = reject;
            });
        },
        [Symbol.asyncIterator]() {
            return this;
        },
        async return(): Promise<IteratorResult<SubscriptionIteratorYield, undefined>> {
            console.log(`[TypeQL WS Transport] Iterator return called (ID: ${subId})`);
            unsubscribe(); // Ensure cleanup
            return { value: undefined, done: true };
        },
        async throw(error?: any): Promise<IteratorResult<SubscriptionIteratorYield>> {
            console.error(`[TypeQL WS Transport] Iterator throw called (ID: ${subId}):`, error);
            // Use onError to signal error and clean up state
            handlers.onError({ message: `Iterator cancelled: ${error?.message || error}` });
            // unsubscribe(); // Cleanup is handled by onError now
            // Need to return a final result after error handling
            return { value: undefined, done: true };
        }
    };

    return { iterator, unsubscribe };
}

/**
 * Handles the request to fetch missing delta messages for a subscription.
 * @param state - The shared connection state.
 * @param subscriptionId - The ID of the subscription.
 * @param fromSeq - The starting sequence number (exclusive).
 * @param toSeq - The ending sequence number (inclusive).
 */
export function requestMissingDeltas(
    state: ConnectionState,
    subscriptionId: number | string,
    fromSeq: number,
    toSeq: number
): void {
    console.log(`[TypeQL WS Transport] Requesting missing deltas for subscription ${subscriptionId} from ${fromSeq} to ${toSeq}`);
    const message: RequestMissingMessage = {
        type: 'request_missing',
        id: subscriptionId, // Use subscriptionId as the correlation ID
        fromSeq,
        toSeq,
    };
    // Only send if connected
    if (state.ws?.readyState === OPEN) {
        if (!sendMessage(state, message)) {
            // Log error, but don't throw, as this is often a recovery mechanism
            console.error(`[TypeQL WS Transport] Failed to send request_missing message for subscription ${subscriptionId}.`);
        }
    } else {
        console.warn(`[TypeQL WS Transport] Cannot send request_missing for ${subscriptionId}: WebSocket not open.`);
        // Optionally: Trigger an error handler or notification?
    }
    // This function doesn't wait for a response, it just fires the request.
}