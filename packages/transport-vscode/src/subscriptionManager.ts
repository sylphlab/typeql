import type {
    SubscribeMessage,
    UnsubscribeMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    RequestMissingMessage,
    UnsubscribeFn,
    VSCodePostMessage,
} from './types';
import { TypeQLClientError } from './types';

// Structure for storing active subscription details
interface ActiveSubscription {
    push: (message: SubscriptionDataMessage | SubscriptionErrorMessage) => void;
    end: () => void;
    originalMessage: SubscribeMessage; // Store for potential resubscription (though not implemented here)
}

// Result type for the create method
export interface SubscriptionResult {
    iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>;
    unsubscribe: UnsubscribeFn;
}

// Interface for the subscription manager
export interface SubscriptionManager {
    create(message: SubscribeMessage): SubscriptionResult;
    pushData(id: string | number, message: SubscriptionDataMessage | SubscriptionErrorMessage): void;
    endSubscription(id: string | number): void;
    endAll(): void;
    hasSubscription(id: string | number): boolean;
    requestMissing(subscriptionId: string | number, fromSeq: number, toSeq: number): void;
}

interface SubscriptionManagerDependencies {
    vscodeApi: VSCodePostMessage;
}

/**
 * Creates a manager for active subscriptions.
 * Encapsulates the state and logic for handling subscription lifecycles,
 * including the async iterator generation.
 *
 * @param deps Dependencies including the VSCode API object for sending messages.
 * @returns An instance of SubscriptionManager.
 */
export function createSubscriptionManager(deps: SubscriptionManagerDependencies): SubscriptionManager {
    const { vscodeApi } = deps;
    const activeSubscriptions = new Map<string | number, ActiveSubscription>();

    return {
        /** Creates a new subscription, sets up the iterator, and sends the initial message. */
        create(message: SubscribeMessage): SubscriptionResult {
            const subscriptionId = message.id;
            if (subscriptionId === undefined) {
                throw new TypeQLClientError("Subscription message must have an ID.");
            }
            if (activeSubscriptions.has(subscriptionId)) {
                // Handle potential duplicate subscription attempts
                console.warn(`[SubscriptionManager] Subscription with ID ${subscriptionId} already exists. Ending previous one.`);
                activeSubscriptions.get(subscriptionId)?.end(); // End the old one
                // Consider throwing an error or returning the existing one? For now, overwrite.
            }

            let push: (message: SubscriptionDataMessage | SubscriptionErrorMessage) => void = () => {};
            let end: () => void = () => {};
            let isEnded = false;

            const iterator = (async function*() {
                const messageQueue: (SubscriptionDataMessage | SubscriptionErrorMessage)[] = [];
                let notifyResolver: (() => void) | null = null;

                push = (msg) => {
                    console.debug(`[SubscriptionManager] push() called for ${subscriptionId}. isEnded=${isEnded}`);
                    if (isEnded) return;
                    messageQueue.push(msg);
                    if (notifyResolver) {
                        console.debug(`[SubscriptionManager] push() resolving awaiter for ${subscriptionId}`);
                        notifyResolver();
                        notifyResolver = null;
                    } else {
                         console.debug(`[SubscriptionManager] push() queued message for ${subscriptionId}, no awaiter.`);
                    }
                };

                end = () => {
                    console.debug(`[SubscriptionManager] end() called for ${subscriptionId}. isEnded=${isEnded}`);
                    if (isEnded) return;
                    isEnded = true;
                    if (notifyResolver) {
                        console.debug(`[SubscriptionManager] end() resolving awaiter for ${subscriptionId}`);
                        notifyResolver();
                        notifyResolver = null;
                    } else {
                         console.debug(`[SubscriptionManager] end() called but no awaiter for ${subscriptionId}`);
                    }
                };

                try {
                    console.debug(`[SubscriptionManager] Iterator starting loop for ${subscriptionId}`);
                    while (!isEnded) {
                        console.debug(`[SubscriptionManager] Iterator loop top for ${subscriptionId}. isEnded=${isEnded}, queueLength=${messageQueue.length}`);
                        while (messageQueue.length > 0) {
                            const msg = messageQueue.shift()!;
                            console.debug(`[SubscriptionManager] Iterator yielding message from queue for ${subscriptionId}:`, msg);
                            yield msg;
                        }

                        if (!isEnded) {
                            console.debug(`[SubscriptionManager] Iterator awaiting next message/end signal: ${subscriptionId}`);
                            const waitPromise = new Promise<void>((resolve) => {
                                notifyResolver = resolve;
                            });
                            await waitPromise;
                            console.debug(`[SubscriptionManager] Iterator notified for ${subscriptionId}. isEnded=${isEnded}`);
                        }
                    }
                    console.debug(`[SubscriptionManager] Iterator loop finished (isEnded=${isEnded}): ${subscriptionId}`);
                } finally {
                    console.debug(`[SubscriptionManager] Iterator finally block for ${subscriptionId}. Setting isEnded=true.`);
                    isEnded = true;
                    notifyResolver = null;
                    activeSubscriptions.delete(subscriptionId);
                    console.debug(`[SubscriptionManager] Subscription iterator cleanup/finally block finished: ${subscriptionId}`);
                }
            })();

            const unsubscribe: UnsubscribeFn = () => {
                if (!isEnded) {
                    console.debug(`[SubscriptionManager] Unsubscribing from ${subscriptionId}`);
                    end(); // End the local iterator FIRST
                    // Send stop message to the other side
                    const unsubMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: subscriptionId };
                    try {
                        vscodeApi.postMessage(unsubMessage);
                    } catch (error) {
                        console.error(`[SubscriptionManager] Failed to send unsubscribe message for ${subscriptionId}:`, error);
                        // The iterator is already ended locally, so state is consistent.
                    }
                } else {
                     console.debug(`[SubscriptionManager] Unsubscribe called on already ended subscription: ${subscriptionId}`);
                }
            };

            // Store subscription details *before* sending the message
            activeSubscriptions.set(subscriptionId, { push, end, originalMessage: message });

            // Send the initial subscribe message
            try {
                console.debug('[SubscriptionManager] Sending subscribe:', message);
                vscodeApi.postMessage(message);
            } catch (error) {
                console.error('[SubscriptionManager] Failed to send subscribe message via postMessage:', error);
                end(); // Clean up local state immediately if send fails
                activeSubscriptions.delete(subscriptionId); // Ensure removal if send fails
                throw new TypeQLClientError(`VSCode postMessage failed for subscribe: ${error instanceof Error ? error.message : String(error)}`);
            }

            return { iterator, unsubscribe };
        },

        /** Pushes data or error messages to the correct subscription iterator. */
        pushData(id, message) {
            const sub = activeSubscriptions.get(id);
            if (sub) {
                sub.push(message);
            } else {
                console.warn(`[SubscriptionManager] Attempted to push data to non-existent subscription ID: ${id}`);
            }
        },

        /** Ends a specific subscription iterator and cleans up its state. */
        endSubscription(id) {
            const sub = activeSubscriptions.get(id);
            if (sub) {
                sub.end(); // This triggers the finally block in the iterator which deletes from the map
            } else {
                console.warn(`[SubscriptionManager] Attempted to end non-existent subscription ID: ${id}`);
            }
        },

        /** Ends all active subscriptions, typically during transport disconnection. */
        endAll() {
            console.warn(`[SubscriptionManager] Ending all (${activeSubscriptions.size}) active subscriptions.`);
            // Create a copy of keys to avoid issues while iterating and modifying the map
            const idsToEnd = Array.from(activeSubscriptions.keys());
            idsToEnd.forEach(id => {
                activeSubscriptions.get(id)?.end();
            });
            // The finally block in each iterator should clear the map, but clear just in case.
            activeSubscriptions.clear();
        },

        /** Checks if a subscription with the given ID is currently active. */
        hasSubscription(id) {
            return activeSubscriptions.has(id);
        },

        /** Sends a request for missing delta updates for a subscription. */
        requestMissing(subscriptionId, fromSeq, toSeq) {
             console.debug(`[SubscriptionManager] Requesting missing deltas for sub ${subscriptionId} from ${fromSeq} to ${toSeq}.`);
             const message: RequestMissingMessage = {
                 type: 'request_missing',
                 id: subscriptionId,
                 fromSeq: fromSeq,
                 toSeq: toSeq
             };
             try {
                 vscodeApi.postMessage(message);
             } catch (error) {
                 console.error(`[SubscriptionManager] Failed to send request_missing message for sub ${subscriptionId}:`, error);
                 // Consider if error handling is needed here (e.g., notify the client?)
             }
        }
    };
}