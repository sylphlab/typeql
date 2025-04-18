import type {
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    AckMessage,
    VSCodeTransportOptions,
    TypeQLTransport,
} from './types';
import { TypeQLClientError, generateId } from './types';
import { setupMessageHandler } from './messageHandler';
import { createRequestManager, type RequestManager } from './requestManager';
import { createSubscriptionManager, type SubscriptionManager, type SubscriptionResult } from './subscriptionManager';

/**
 * Creates a TypeQL transport adapter for VSCode extension communication using postMessage.
 * Handles sending messages to the extension host and receiving responses/updates.
 *
 * @param options Configuration options including the VSCode API object.
 * @returns An instance of TypeQLTransport tailored for VSCode.
 */
export function createVSCodeTransport(options: VSCodeTransportOptions): TypeQLTransport {
    const { vscodeApi, generateRequestId = generateId } = options;

    // Store cleanup functions registered via onDisconnect (if we re-introduce it)
    // For now, these are internal cleanup listeners triggered by disconnect()
    const disconnectListeners = new Set<() => void>();

    // --- State Managers ---
    const requestManager: RequestManager = createRequestManager();
    const subscriptionManager: SubscriptionManager = createSubscriptionManager({ vscodeApi });

    // --- Transport Instance ---
    // Need a way for the message handler to access the transport instance, especially for onAckReceived.
    // We can define it partially here and complete it later, or use a getter function.
    let transportInstance: TypeQLTransport | undefined = undefined;
    const getTransportInstance = (): TypeQLTransport | undefined => transportInstance;

    // --- Message Handling ---
    const messageHandlerDisposable = setupMessageHandler({
        vscodeApi,
        requestManager,
        subscriptionManager,
        getTransportInstance, // Pass the getter
    });

    // --- Dispose Logic ---
    const disposeTransport = () => {
        console.log('[VSCode Transport] Disposing transport...');
        messageHandlerDisposable.dispose(); // Stop listening to messages

        // Notify registered internal disconnect listeners
        disconnectListeners.forEach(listener => {
            try {
                listener();
            } catch (error) {
                console.error('[VSCode Transport] Error during internal disconnect listener execution:', error);
            }
        });
        disconnectListeners.clear();

        // Reject pending requests via the manager
        requestManager.rejectAll(new TypeQLClientError('Transport disconnected'));

        // End active subscriptions via the manager
        subscriptionManager.endAll();

        transportInstance = undefined; // Clear reference
        console.log('[VSCode Transport] Transport disposed.');
    };

    // --- Assemble Transport Object ---
    transportInstance = {
        /** Sends a single query or mutation request. */
        request: (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
            return new Promise((resolve, reject) => {
                // Assign ID if missing (though client should usually handle this)
                if (message.id === undefined) {
                    message.id = generateRequestId();
                    console.warn(`[VSCode Transport] Request message was missing an ID. Assigned: ${message.id}`);
                    // If ID generation is critical and might fail, handle that case.
                }
                const id = message.id; // Use guaranteed ID

                // Add to pending requests *before* sending
                requestManager.add(id, resolve, reject);

                try {
                    console.debug('[VSCode Transport] Sending request:', message);
                    vscodeApi.postMessage(message);
                } catch (error) {
                    console.error('[VSCode Transport] Failed to send request via postMessage:', error);
                    // If sending fails, immediately reject and remove from pending
                    requestManager.rejectRequest(id, new TypeQLClientError(`VSCode postMessage failed: ${error instanceof Error ? error.message : String(error)}`));
                }
            });
        },

        /** Initiates a subscription. */
        subscribe: (message: SubscribeMessage): SubscriptionResult => {
             // Assign ID if missing
             if (message.id === undefined) {
                message.id = generateRequestId();
                console.warn(`[VSCode Transport] Subscribe message was missing an ID. Assigned: ${message.id}`);
            }
            // Delegate creation to the subscription manager
            // It handles sending the message and setting up the iterator/unsubscribe
            try {
                 return subscriptionManager.create(message);
            } catch (error) {
                 // If subscriptionManager.create throws (e.g., postMessage fails), re-throw or handle
                 console.error('[VSCode Transport] Error initiating subscription:', error);
                 // Ensure error is of a consistent type if re-throwing
                 if (error instanceof TypeQLClientError) {
                     throw error;
                 }
                 throw new TypeQLClientError(`Failed to initiate subscription: ${error instanceof Error ? error.message : String(error)}`);
            }
        },

        /** Handler called when an AckMessage is received. Set by the client/store. */
        // This needs to be assignable by the consumer of the transport
        onAckReceived: undefined as ((ack: AckMessage) => void) | undefined,

        /** Sends a request for missing delta updates for a subscription. */
        requestMissingDeltas: (subscriptionId: string | number, fromSeq: number, toSeq: number) => {
            // Delegate to the subscription manager
            subscriptionManager.requestMissing(subscriptionId, fromSeq, toSeq);
        },

        /** Disconnects the transport, cleans up listeners, and notifies handlers. */
        disconnect: disposeTransport,

        // --- Potential future additions ---
        // onDisconnect: (listener: () => void): { dispose: () => void } => {
        //     disconnectListeners.add(listener);
        //     return {
        //         dispose: () => {
        //             disconnectListeners.delete(listener);
        //         }
        //     };
        // },
    };

    return transportInstance;
}

console.log("@typeql/transport-vscode main transport logic loaded");