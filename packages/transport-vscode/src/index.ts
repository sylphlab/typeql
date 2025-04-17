import {
    type TypeQLTransport,
    type ProcedureCallMessage,
    type ProcedureResultMessage,
    type SubscribeMessage,
    type UnsubscribeMessage,
    type SubscriptionDataMessage,
    type SubscriptionErrorMessage,
    type SubscriptionEndMessage, // Import for potential use in listener/send
    type AckMessage,
    type RequestMissingMessage, // Import RequestMissingMessage
    type UnsubscribeFn,
    TypeQLClientError, // Import error type as a value
    generateId // Assuming generateId is exported
} from '@sylph/typeql-shared'; // Use shared package

/**
 * Interface mimicking the relevant parts of the VSCode API object
 * obtained via `acquireVsCodeApi()` in a webview context.
 */
interface VSCodePostMessage {
    postMessage(message: any): void; // Use 'any' for flexibility with postMessage
    onDidReceiveMessage(listener: (message: any) => void): { dispose: () => void };
}

/** Union type for messages expected *from* the VSCode extension host. */
type IncomingMessage =
    | ProcedureResultMessage
    | SubscriptionDataMessage
    | SubscriptionErrorMessage
    | SubscriptionEndMessage // Handle end message?
    | AckMessage;

/** Options for creating the VSCode transport. */
export interface VSCodeTransportOptions {
    /**
     * The VSCode API object, typically acquired via `acquireVsCodeApi()` in a webview.
     * This object provides `postMessage` and `onDidReceiveMessage`.
     */
    vscodeApi: VSCodePostMessage;
    /** Optional function to generate unique request/subscription IDs. Defaults to a simple counter. */
    generateRequestId?: () => string | number;
}

/**
 * Creates a TypeQL transport adapter for VSCode extension communication using postMessage.
 * Handles sending messages to the extension host and receiving responses/updates.
 *
 * @param options Configuration options including the VSCode API object.
 * @returns An instance of TypeQLTransport tailored for VSCode.
 */
export function createVSCodeTransport(options: VSCodeTransportOptions): TypeQLTransport {
    const { vscodeApi, generateRequestId = generateId } = options;

    // Store pending requests and subscriptions
    const pendingRequests = new Map<string | number, { resolve: (result: ProcedureResultMessage) => void; reject: (reason?: any) => void }>();
    const activeSubscriptions = new Map<string | number, {
        // Store the push function for the async iterator
        push: (message: SubscriptionDataMessage | SubscriptionErrorMessage) => void;
        // Store the function to signal the end of the iterator
        end: () => void;
        // Store the original subscribe message for potential resubscription
        originalMessage: SubscribeMessage;
    }>();

    // Store cleanup functions registered via onDisconnect
    const disconnectListeners = new Set<() => void>();

    // Listener for messages coming *from* the extension host/webview counterpart
    const messageListener = vscodeApi.onDidReceiveMessage((message: any) => { // Use 'any' initially, apply guards inside
        console.debug('[VSCode Transport] Received message:', message);

        // --- Type Guards & Message Handling ---
        // ProcedureResultMessage: Has 'result' property
        if (typeof message === 'object' && message !== null && 'result' in message && 'id' in message) {
            const msg = message as ProcedureResultMessage;
            const pending = pendingRequests.get(msg.id);
            if (pending) {
                pending.resolve(msg);
                pendingRequests.delete(msg.id);
            } else {
                console.warn(`[VSCode Transport] Received response for unknown request ID: ${msg.id}`);
            }
        }
        // AckMessage: Has 'type' === 'ack' and 'clientSeq'
        else if (typeof message === 'object' && message !== null && message.type === 'ack' && 'clientSeq' in message && 'id' in message) {
            const msg = message as AckMessage;
            // Need to access transport via closure or re-fetch if needed, direct access might be problematic during initialization
            const currentTransport = transport; // Capture transport instance
            if (currentTransport?.onAckReceived) {
                try {
                    currentTransport.onAckReceived(msg);
                } catch (ackError) {
                    console.error("[VSCode Transport] Error in onAckReceived handler:", ackError);
                }
            } else {
                console.debug("[VSCode Transport] Received ack, but no onAckReceived handler configured.");
            }
        }
        // SubscriptionDataMessage: Has 'type' === 'subscriptionData' and 'serverSeq'
        else if (typeof message === 'object' && message !== null && message.type === 'subscriptionData' && 'serverSeq' in message && 'id' in message) {
            const msg = message as SubscriptionDataMessage;
            const sub = activeSubscriptions.get(msg.id);
            if (sub) {
                console.debug(`[VSCode Transport] Found active subscription ${msg.id}, calling push...`);
                sub.push(msg); // Pass correctly typed message
            } else {
                console.warn(`[VSCode Transport] Received subscription data for unknown subscription ID: ${msg.id}`);
            }
        }
        // SubscriptionErrorMessage: Has 'type' === 'subscriptionError' and 'error'
        else if (typeof message === 'object' && message !== null && message.type === 'subscriptionError' && 'error' in message && 'id' in message) {
            const msg = message as SubscriptionErrorMessage;
            const sub = activeSubscriptions.get(msg.id);
            if (sub) {
                sub.push(msg); // Pass correctly typed message
            } else {
                console.warn(`[VSCode Transport] Received subscription error for unknown subscription ID: ${msg.id}`);
            }
        }
        // SubscriptionEndMessage: Has 'type' === 'subscriptionEnd'
        else if (typeof message === 'object' && message !== null && message.type === 'subscriptionEnd' && 'id' in message) {
            const msg = message as SubscriptionEndMessage;
            const sub = activeSubscriptions.get(msg.id);
            if (sub) {
                sub.end(); // Signal the end of the iterator
            } else {
                console.warn(`[VSCode Transport] Received subscription end for unknown subscription ID: ${msg.id}`);
            }
        }
         // --- End Type Guards & Message Handling ---
         else {
              console.warn("[VSCode Transport] Received unknown/unhandled message format:", message);
         }
     });

     // Function to clean up this transport instance
     const disposeTransport = () => {
         console.log('[VSCode Transport] Disposing transport...');
         messageListener.dispose(); // Stop listening to messages
         // Notify registered disconnect listeners
         disconnectListeners.forEach(listener => {
             try {
                 listener();
             } catch (error) {
                 console.error('[VSCode Transport] Error during disconnect listener execution:', error);
             }
         });
         disconnectListeners.clear();
         // Reject pending requests
         pendingRequests.forEach((pending, id) => {
             console.warn(`[VSCode Transport] Discarding pending request ${id} due to transport disposal.`);
             pending.reject(new TypeQLClientError('Transport disconnected'));
         });
         pendingRequests.clear();
         // End active subscriptions
         activeSubscriptions.forEach(sub => sub.end()); // This also removes them from the map
         activeSubscriptions.clear(); // Ensure map is empty
         console.log('[VSCode Transport] Transport disposed.');
     };


     const transport: TypeQLTransport = {
         /**
          * Sends a single query or mutation request.
          * @param message The procedure call message.
          * @returns A promise resolving with the result message.
          */
         request: (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
            return new Promise((resolve, reject) => {
                if (message.id === undefined) {
                    console.error("[VSCode Transport] Request message is missing an ID:", message);
                    // Use TypeQLClientError for consistency
                    return reject(new TypeQLClientError("Request message must have an ID."));
                }
                // Store both resolve and reject
                pendingRequests.set(message.id, { resolve, reject });
                try {
                    console.debug('[VSCode Transport] Sending request:', message);
                    vscodeApi.postMessage(message);
                } catch (error) {
                    console.error('[VSCode Transport] Failed to send request via postMessage:', error);
                    pendingRequests.delete(message.id);
                    reject(new TypeQLClientError(`VSCode postMessage failed: ${error instanceof Error ? error.message : String(error)}`));
                }
            });
        },

        /**
         * Initiates a subscription.
         * @param message The subscription request message.
         * @returns An object containing the async iterator and an unsubscribe function.
         */
        subscribe: (message: SubscribeMessage) => {
            const subscriptionId = message.id;
            if (subscriptionId === undefined) {
                 // Should ideally be caught by client, but double-check
                 throw new TypeQLClientError("Subscription message must have an ID.");
            }

            let push: (message: SubscriptionDataMessage | SubscriptionErrorMessage) => void = () => {};
            let end: () => void = () => {};
            let isEnded = false;

            const iterator = (async function*() {
                const messageQueue: (SubscriptionDataMessage | SubscriptionErrorMessage)[] = [];
                let notifyNext: (() => void) | null = null; // Signal that a message/end is ready
                let nextMessagePromise: Promise<void> | null = null; // Promise to await

                const createNextMessagePromise = () => {
                    nextMessagePromise = new Promise<void>((resolve) => {
                        notifyNext = resolve;
                    });
                };

                // Push function
                push = (msg) => {
                    console.debug(`[VSCode Transport] push() called for ${subscriptionId}. isEnded=${isEnded}`);
                    if (isEnded) return;
                    messageQueue.push(msg);
                    if (notifyNext) {
                        console.debug(`[VSCode Transport] push() notifying awaiter for ${subscriptionId}`);
                        notifyNext();
                        notifyNext = null; // Consume the notification
                    } else {
                         console.debug(`[VSCode Transport] push() queued message for ${subscriptionId}, no awaiter.`);
                    }
                };

                // End function - Sets flag and notifies awaiter
                end = () => {
                    console.debug(`[VSCode Transport] end() called for ${subscriptionId}. isEnded=${isEnded}`);
                    if (isEnded) return;
                    isEnded = true;
                    if (notifyNext) {
                        console.debug(`[VSCode Transport] end() notifying awaiter for ${subscriptionId}`);
                        notifyNext(); // Signal the end
                        notifyNext = null;
                    } else {
                         console.debug(`[VSCode Transport] end() called but no awaiter for ${subscriptionId}`);
                    }
                };

                // Initialize the first promise
                createNextMessagePromise();

                // Try/finally block
                try {
                    console.debug(`[VSCode Transport] Iterator starting loop for ${subscriptionId}`);
                    while (!isEnded) {
                        console.debug(`[VSCode Transport] Iterator loop top for ${subscriptionId}. isEnded=${isEnded}, queueLength=${messageQueue.length}`);
                        while (messageQueue.length > 0) {
                            const msg = messageQueue.shift()!;
                            console.debug(`[VSCode Transport] Iterator yielding message from queue for ${subscriptionId}:`, msg);
                            yield msg;
                        }

                        // If queue is empty and not ended, wait for next message/end signal
                        if (!isEnded) {
                            console.debug(`[VSCode Transport] Iterator awaiting next message/end signal: ${subscriptionId}`);
                            // Ensure nextMessagePromise is not null before awaiting
                            if (!nextMessagePromise) createNextMessagePromise();
                            await nextMessagePromise; // Wait for push or end
                            console.debug(`[VSCode Transport] Iterator notified for ${subscriptionId}. isEnded=${isEnded}`);
                            // If not ended after await, create the next promise for the next loop iteration
                            if (!isEnded) {
                                createNextMessagePromise();
                            }
                        }
                    }
                    console.debug(`[VSCode Transport] Iterator loop finished (isEnded=${isEnded}): ${subscriptionId}`);
                } finally {
                    console.debug(`[VSCode Transport] Iterator finally block for ${subscriptionId}. Setting isEnded=true.`);
                    isEnded = true; // Ensure flag is set on exit
                    notifyNext = null; // Clear any dangling notifier
                    activeSubscriptions.delete(subscriptionId); // Centralize cleanup
                    console.debug(`[VSCode Transport] Subscription iterator cleanup/finally block finished: ${subscriptionId}`);
                }
            })();

            /** Function to call to stop the subscription */
            const unsubscribe: UnsubscribeFn = () => {
                if (!isEnded) {
                    console.debug(`[VSCode Transport] Unsubscribing from ${subscriptionId}`);
                    end(); // End the local iterator
                    // Send stop message to the other side
                    const unsubMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: subscriptionId };
                    try {
                        vscodeApi.postMessage(unsubMessage);
                    } catch (error) {
                        console.error(`[VSCode Transport] Failed to send unsubscribe message for ${subscriptionId}:`, error);
                    }
                } else {
                     console.debug(`[VSCode Transport] Unsubscribe called on already ended subscription: ${subscriptionId}`);
                }
            };

            // Store subscription details
            activeSubscriptions.set(subscriptionId, { push, end, originalMessage: message });

            // Send the initial subscribe message
            try {
                console.debug('[VSCode Transport] Sending subscribe:', message);
                vscodeApi.postMessage(message);
            } catch (error) {
                console.error('[VSCode Transport] Failed to send subscribe message via postMessage:', error);
                end(); // Clean up local state
                throw new TypeQLClientError(`VSCode postMessage failed for subscribe: ${error instanceof Error ? error.message : String(error)}`);
            }

            return { iterator, unsubscribe };
        },

        /** Handler called when an AckMessage is received. Set by the client/store. */
        onAckReceived: undefined, // Needs to be assignable

        /**
         * Sends a request to the server for missing delta updates for a subscription.
         * @param subscriptionId The ID of the subscription.
         * @param fromSeq The sequence number to start requesting from (exclusive).
         * @param toSeq The sequence number to request up to (inclusive).
         */
        requestMissingDeltas: (subscriptionId: string | number, fromSeq: number, toSeq: number) => {
             console.debug(`[VSCode Transport] Requesting missing deltas for sub ${subscriptionId} from ${fromSeq} to ${toSeq}.`);
             const message: RequestMissingMessage = {
                 type: 'request_missing', // Ensure this type is correct as per core types
                 id: subscriptionId,
                 fromSeq: fromSeq,
                 toSeq: toSeq
             };
             try {
                 vscodeApi.postMessage(message);
             } catch (error) {
                 console.error(`[VSCode Transport] Failed to send request_missing message for sub ${subscriptionId}:`, error);
             }
        },

        // Removed onDisconnect as it's not in the core TypeQLTransport interface

        /**
         * Disconnects the transport, cleans up listeners, and notifies handlers.
         */
        disconnect: disposeTransport, // Assign the internal dispose function
    };

    return transport;
}

console.log("@typeql/transport-vscode loaded");