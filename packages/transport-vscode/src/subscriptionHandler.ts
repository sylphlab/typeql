import type {
    SubscribeMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    UnsubscribeFn,
} from '@sylphlab/zen-query-shared';
import type { ActiveSubscription } from './types';
import { generateIdHelper, createUnsubscribeFn, cleanupSubscriptionHelper } from './helpers'; // Import helpers

// Minimal interface for the transport context needed by the subscribe handler
// Needs methods/properties used by helpers as well
interface SubscribeHandlerTransportContext {
    nextId: number; // For generateIdHelper
    activeSubscriptions: Map<number | string, ActiveSubscription>;
    vscodeApi: { postMessage: (message: any) => void };
    // Need cleanupSubscription for createUnsubscribeFn helper context
    cleanupSubscription: (id: number | string, notifyComplete?: boolean) => void;
}

/**
 * Handles the initiation of a subscription.
 * Creates the ActiveSubscription state and the AsyncIterableIterator.
 *
 * @param transport The transport context containing necessary state and methods.
 * @param message The subscription initiation message.
 * @returns An object containing the AsyncIterableIterator and an unsubscribe function.
 */
export function handleSubscribe(
    transport: SubscribeHandlerTransportContext,
    message: SubscribeMessage
): {
    iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>;
    unsubscribe: UnsubscribeFn;
} {
    // Use helper to generate ID
    const id = message.id ?? generateIdHelper(transport);
    const msgWithId = { ...message, id };

    const subscription: ActiveSubscription = {
        buffer: [],
        resolveNext: null,
        rejectIterator: null,
        isComplete: false,
    };
    transport.activeSubscriptions.set(id, subscription);

    // Use helper to create the unsubscribe function
    // Pass the transport context needed by the helper
    const unsubscribe = createUnsubscribeFn(transport, id);

    const iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> = {
        [Symbol.asyncIterator]() {
            return this;
        },
        next: async () => {
            if (subscription.buffer.length > 0) {
                // Return buffered data immediately
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                return { done: false, value: subscription.buffer.shift()! };
            }
            if (subscription.isComplete) {
                // Subscription ended
                return { done: true, value: undefined };
            }
            // Wait for new data
            return new Promise<IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>>((resolve, reject) => {
                subscription.resolveNext = resolve;
                subscription.rejectIterator = reject; // Store rejector for cleanup/error
            });
        },
        return: () => { // Make synchronous
            if (!subscription.isComplete) {
                subscription.isComplete = true;
                try {
                    // Call the created unsubscribe function
                    unsubscribe();
                } catch (e) {
                    console.error("Error during iterator return's unsubscribe call:", e);
                }
            }
            return Promise.resolve({ done: true, value: undefined });
        },
        throw: async (error?: any) => {
             if (!subscription.isComplete) {
                 // Call the created unsubscribe function
                 unsubscribe();
             }
             return Promise.reject(error);
        }
    };

    try {
        transport.vscodeApi.postMessage(msgWithId);
    } catch (error) {
        // Use helper for cleanup
        cleanupSubscriptionHelper(transport, id);
        throw error;
    }

    return { iterator, unsubscribe };
}