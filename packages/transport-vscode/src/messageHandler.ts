import type {
    AckMessage,
    ProcedureResultMessage,
    SubscriptionDataMessage,
    SubscriptionEndMessage,
    SubscriptionErrorMessage,
} from '@sylphlab/typeql-shared';
import type { PendingRequest, ActiveSubscription } from './types';
import { cleanupSubscriptionHelper } from './helpers'; // Import helper

// Define a minimal interface for the transport context needed by the handler
// This interface is used internally by the factory, not passed directly anymore
interface MessageHandlerTransportContext {
    pendingRequests: Map<number | string, PendingRequest>;
    activeSubscriptions: Map<number | string, ActiveSubscription>;
}


/**
 * Creates the message handler function for the VSCodeTransport.
 * This decouples the message processing logic from the main class structure.
 *
 * @param pendingRequests Map of pending requests.
 * @param activeSubscriptions Map of active subscriptions.
 * @param getOnAckReceived Function that returns the current ack handler.
 * @param cleanupSubscription Function to clean up subscription state (passed for context).
 * @returns The event handler function for 'message' events.
 */
export function createMessageHandler(
    pendingRequests: Map<number | string, PendingRequest>,
    activeSubscriptions: Map<number | string, ActiveSubscription>,
    getOnAckReceived: () => (((ack: AckMessage) => void) | undefined),
    // Pass cleanup function for context, even though helper is used internally
    // This maintains consistency if other parts need it directly.
    // Alternatively, pass the full transport context if helper needs more.
    cleanupSubscription: (id: number | string, notifyComplete?: boolean) => void
): (event: MessageEvent) => void {

    // Create a context object for the helper function if needed,
    // or pass individual maps directly if the helper only needs those.
    const transportContext = { activeSubscriptions }; // Context for cleanup helper

    const handleIncomingMessage = (event: MessageEvent): void => {
        const message = event.data as any; // Assume data is a valid TypeQL message

        if (!message || typeof message.id === 'undefined') {
            return;
        }

        const id = message.id;

        // Procedure Result
        if (message.result && (message.result.type === 'data' || message.result.type === 'error')) {
            const pending = pendingRequests.get(id);
            if (pending) {
                if (message.result.type === 'data') {
                    pending.resolve(message as ProcedureResultMessage);
                } else {
                    pending.reject(message.result.error);
                }
                pendingRequests.delete(id);
            }
            return;
        }

        // Subscription Messages
        const subscription = activeSubscriptions.get(id);
        if (subscription) {
            switch (message.type) {
                case 'subscriptionData':
                case 'subscriptionError':
                    if (subscription.resolveNext) {
                        subscription.resolveNext({ done: false, value: message });
                        subscription.resolveNext = null;
                        subscription.rejectIterator = null;
                    } else {
                        subscription.buffer.push(message);
                    }
                    if (message.type === 'subscriptionError') {
                        subscription.isComplete = true;
                        // Use helper for cleanup
                        cleanupSubscriptionHelper(transportContext, id, false);
                    }
                    break;

                case 'subscriptionEnd':
                    subscription.isComplete = true;
                    if (subscription.resolveNext) {
                        subscription.resolveNext({ done: true, value: undefined });
                    }
                     // Use helper for cleanup
                    cleanupSubscriptionHelper(transportContext, id, false);
                    break;
            }
            return;
        }

        // Ack Message
        if (message.type === 'ack' && message.clientSeq !== undefined && message.serverSeq !== undefined) {
            // Get the current handler via the getter and call it
            getOnAckReceived()?.(message as AckMessage);
            return;
        }

        // console.warn('Received unknown/uncorrelated message:', message);
    };

    return handleIncomingMessage;
}