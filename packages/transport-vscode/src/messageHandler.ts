import type {
    ProcedureResultMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    SubscriptionEndMessage,
    AckMessage,
    VSCodePostMessage,
    TypeQLTransport, // Import the core transport interface
} from './types'; // Import from the new types file

// Define interfaces for the state managers this handler needs to interact with
interface RequestManager {
    resolveRequest(id: string | number, message: ProcedureResultMessage): void;
    hasRequest(id: string | number): boolean;
}

interface SubscriptionManager {
    pushData(id: string | number, message: SubscriptionDataMessage | SubscriptionErrorMessage): void;
    endSubscription(id: string | number): void;
    hasSubscription(id: string | number): boolean;
}

interface MessageHandlerDependencies {
    vscodeApi: VSCodePostMessage;
    requestManager: RequestManager;
    subscriptionManager: SubscriptionManager;
    // Pass the transport instance itself, or just the relevant parts like onAckReceived
    // Passing the whole instance might be simpler for now, but consider refining later.
    getTransportInstance: () => TypeQLTransport | undefined;
}

/**
 * Creates and registers the message listener for incoming messages from VSCode.
 *
 * @param deps Dependencies including the VSCode API and state managers.
 * @returns A dispose function to remove the listener.
 */
export function setupMessageHandler(deps: MessageHandlerDependencies): { dispose: () => void } {
    const { vscodeApi, requestManager, subscriptionManager, getTransportInstance } = deps;

    const listenerDisposable = vscodeApi.onDidReceiveMessage((message: any) => {
        console.debug('[VSCode MessageHandler] Received message:', message);

        // Basic validation
        if (typeof message !== 'object' || message === null || !('id' in message)) {
            console.warn("[VSCode MessageHandler] Received invalid message format (missing id or not an object):", message);
            return;
        }

        const id = message.id; // All valid messages should have an ID

        // --- Type Guards & Message Handling ---

        // ProcedureResultMessage: Has 'result' property
        if ('result' in message) {
            const msg = message as ProcedureResultMessage;
            if (requestManager.hasRequest(msg.id)) {
                requestManager.resolveRequest(msg.id, msg);
            } else {
                console.warn(`[VSCode MessageHandler] Received response for unknown request ID: ${msg.id}`);
            }
        }
        // AckMessage: Has 'type' === 'ack' and 'clientSeq'
        else if (message.type === 'ack' && 'clientSeq' in message) {
            const msg = message as AckMessage;
            const transport = getTransportInstance(); // Get current transport instance
            if (transport?.onAckReceived) {
                try {
                    transport.onAckReceived(msg);
                } catch (ackError) {
                    console.error("[VSCode MessageHandler] Error in onAckReceived handler:", ackError);
                }
            } else {
                console.debug("[VSCode MessageHandler] Received ack, but no onAckReceived handler configured.");
            }
        }
        // SubscriptionDataMessage: Has 'type' === 'subscriptionData' and 'serverSeq'
        else if (message.type === 'subscriptionData' && 'serverSeq' in message) {
            const msg = message as SubscriptionDataMessage;
            if (subscriptionManager.hasSubscription(msg.id)) {
                subscriptionManager.pushData(msg.id, msg);
            } else {
                console.warn(`[VSCode MessageHandler] Received data for unknown subscription ID: ${msg.id}`);
            }
        }
        // SubscriptionErrorMessage: Has 'type' === 'subscriptionError' and 'error'
        else if (message.type === 'subscriptionError' && 'error' in message) {
            const msg = message as SubscriptionErrorMessage;
            if (subscriptionManager.hasSubscription(msg.id)) {
                subscriptionManager.pushData(msg.id, msg);
            } else {
                console.warn(`[VSCode MessageHandler] Received error for unknown subscription ID: ${msg.id}`);
            }
        }
        // SubscriptionEndMessage: Has 'type' === 'subscriptionEnd'
        else if (message.type === 'subscriptionEnd') {
            const msg = message as SubscriptionEndMessage;
            if (subscriptionManager.hasSubscription(msg.id)) {
                subscriptionManager.endSubscription(msg.id);
            } else {
                console.warn(`[VSCode MessageHandler] Received end for unknown subscription ID: ${msg.id}`);
            }
        }
        // --- End Type Guards & Message Handling ---
        else {
            console.warn("[VSCode MessageHandler] Received unknown/unhandled message format:", message);
        }
    });

    return { dispose: listenerDisposable.dispose };
}