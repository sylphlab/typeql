import type {
    zenQueryTransport,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    UnsubscribeMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    AckMessage,
    RequestMissingMessage,
    UnsubscribeFn,
} from '@sylphlab/zen-query-shared';
import { zenQueryClientError, generateId } from '@sylphlab/zen-query-shared';

// --- Types ---

type WebSocketConstructor = typeof WebSocket;

export type WebSocketTransportOptions = {
    /** URL of the WebSocket server. */
    url: string;
    /** Optional WebSocket protocols. */
    protocols?: string | string[];
    /** Maximum number of reconnection attempts. Default: 3. Set to 0 to disable. */
    retryAttempts?: number;
    /** Delay between reconnection attempts in milliseconds. Default: 5000. */
    retryDelayMs?: number;
    /** Optional custom WebSocket implementation (e.g., 'ws' in Node.js). */
    WebSocket?: WebSocketConstructor;
    /** Optional: Called when the connection opens successfully. */
    onOpen?: () => void;
    /** Optional: Called when the connection closes. */
    onClose?: (event: CloseEvent) => void;
    /** Optional: Called when a WebSocket error occurs. */
    onError?: (event: Event) => void;
};

type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closing' | 'closed';

type PendingRequest = {
    resolve: (value: ProcedureResultMessage) => void;
    reject: (reason?: any) => void;
};

type ActiveSubscription = {
    // Handlers for the AsyncIterableIterator
    pushData: (data: SubscriptionDataMessage) => void;
    pushError: (error: SubscriptionErrorMessage) => void;
    end: () => void;
    // Store the original message for potential resubscription
    originalMessage: SubscribeMessage;
};

// --- Implementation ---

export function createWebSocketTransport(options: WebSocketTransportOptions): zenQueryTransport {
    const {
        url,
        protocols,
        retryAttempts = 3,
        retryDelayMs = 5000,
        WebSocket: WebSocketImpl = globalThis.WebSocket, // Use global WebSocket by default
    } = options;

    let ws: WebSocket | null = null;
    let status: ConnectionStatus = 'idle';
    let retriesMade = 0;
    let connectionListeners = new Set<(connected: boolean) => void>();
    let disconnectListeners = new Set<() => void>();
    let pendingRequests = new Map<string | number, PendingRequest>();
    let activeSubscriptions = new Map<string | number, ActiveSubscription>();
    let ackListeners = new Set<(ack: AckMessage) => void>(); // Listeners for AckMessages

    const WS_READY_STATE_OPEN = 1; // WebSocket.OPEN

    // --- Helper Functions ---

    function updateStatus(newStatus: ConnectionStatus) {
        if (status === newStatus) return;
        const oldStatus = status;
        status = newStatus;
        console.log(`WebSocketTransport: Status changed ${oldStatus} -> ${newStatus}`);

        const isConnected = newStatus === 'open';
        const wasConnected = oldStatus === 'open';

        if (isConnected !== wasConnected) {
            connectionListeners.forEach(handler => handler(isConnected));
        }
        if (!isConnected && wasConnected) {
            disconnectListeners.forEach(handler => handler());
            // Reject pending requests on disconnect
            pendingRequests.forEach((req) => {
                req.reject(new zenQueryClientError('Connection closed', 'CONNECTION_CLOSED'));
            });
            pendingRequests.clear();
            // Notify active subscriptions of error/end? Depends on desired behavior.
            // For now, let's assume they implicitly end on disconnect.
            activeSubscriptions.forEach(sub => sub.end()); // End iterators
            activeSubscriptions.clear();
        }
    }

    function sendMessage(payload: any) {
        if (ws?.readyState !== WS_READY_STATE_OPEN) {
            console.error("WebSocketTransport: Cannot send message, connection not open.");
            return false;
        }
        try {
            const message = JSON.stringify(payload);
            ws.send(message);
            return true;
        } catch (error) {
            console.error("WebSocketTransport: Failed to stringify or send message:", error, payload);
            options.onError?.(new ErrorEvent('senderror', { error: error, message: 'Failed to send message' }));
            return false;
        }
    }

    function handleReconnection(closeEvent: CloseEvent) {
        if (status === 'closing' || closeEvent.code === 1000 || retryAttempts === 0) {
            updateStatus('closed');
            return;
        }

        if (retriesMade < retryAttempts) {
            retriesMade++;
            updateStatus('reconnecting');
            console.log(`WebSocketTransport: Attempting to reconnect in ${retryDelayMs / 1000} seconds... (Retry ${retriesMade}/${retryAttempts})`);
            setTimeout(() => {
                if (status === 'reconnecting') {
                    connectInternal();
                }
            }, retryDelayMs);
        } else {
            updateStatus('closed');
            console.error(`WebSocketTransport: Max reconnection retries (${retryAttempts}) reached for ${url}.`);
        }
    }

    function connectInternal() {
        if (status !== 'idle' && status !== 'closed' && status !== 'reconnecting') {
            console.warn(`WebSocketTransport: Cannot connect while in state: ${status}`);
            return;
        }

        if (!WebSocketImpl) {
            console.error('WebSocketTransport: WebSocket implementation not available.');
            updateStatus('closed');
            options.onClose?.({ code: 1001, reason: 'WebSocket implementation not available', wasClean: false } as CloseEvent);
            return;
        }

        updateStatus('connecting');
        console.log(`WebSocketTransport: Attempting to connect to ${url}...`);

        try {
            ws = new WebSocketImpl(url, protocols);

            ws.onopen = () => {
                retriesMade = 0; // Reset retries on successful connection
                updateStatus('open');
                options.onOpen?.();
                // Resubscribe to active subscriptions? (Requires storing original messages)
                activeSubscriptions.forEach((sub, id) => {
                    console.log(`WebSocketTransport: Resubscribing to ${id}`);
                    sendMessage(sub.originalMessage);
                });
            };

            ws.onmessage = (event) => {
                let messageData: any;
                try {
                    messageData = JSON.parse(event.data);
                } catch (error) {
                    console.error('WebSocketTransport: Failed to parse incoming message:', error, 'Raw data:', event.data);
                    return;
                }

                // --- Message Routing ---
                if (typeof messageData !== 'object' || messageData === null || !('id' in messageData)) {
                    console.warn('WebSocketTransport: Received invalid message format:', messageData);
                    return;
                }

                const id = messageData.id;

                if ('result' in messageData) { // ProcedureResultMessage
                    const pending = pendingRequests.get(id);
                    if (pending) {
                        pending.resolve(messageData as ProcedureResultMessage);
                        pendingRequests.delete(id);
                    } else {
                        console.warn(`WebSocketTransport: Received result for unknown request ID: ${id}`);
                    }
                } else if (messageData.type === 'subscriptionData' || messageData.type === 'subscriptionError' || messageData.type === 'subscriptionEnd') { // SubscriptionLifecycleMessage (Server -> Client)
                    const sub = activeSubscriptions.get(id);
                    if (sub) {
                        if (messageData.type === 'subscriptionData') {
                            sub.pushData(messageData as SubscriptionDataMessage);
                        } else if (messageData.type === 'subscriptionError') {
                            sub.pushError(messageData as SubscriptionErrorMessage);
                            activeSubscriptions.delete(id); // Assume error ends subscription
                        } else if (messageData.type === 'subscriptionEnd') {
                            sub.end();
                            activeSubscriptions.delete(id);
                        }
                    } else {
                        // It's possible to receive messages for a subscription that was just unsubscribed locally
                        // console.warn(`WebSocketTransport: Received message for unknown subscription ID: ${id}`);
                    }
                } else if (messageData.type === 'ack') { // AckMessage
                    ackListeners.forEach(listener => listener(messageData as AckMessage));
                } else {
                    console.warn(`WebSocketTransport: Received unhandled message type:`, messageData);
                }
            };

            ws.onerror = (event) => {
                console.error('WebSocketTransport: Error occurred:', event);
                options.onError?.(event);
                // Close event will usually follow
            };

            ws.onclose = (event) => {
                console.log(`WebSocketTransport: Connection closed. Code: ${event.code}, Reason: ${event.reason}, Clean: ${event.wasClean}`);
                const previousStatus = status;
                ws = null; // Clean up instance

                // Update status before calling handlers/reconnection
                updateStatus('closed');

                // Call external onClose handler regardless of initiation method
                options.onClose?.(event);

                // Attempt reconnection only if closure wasn't initiated by disconnect()
                if (previousStatus !== 'closing') {
                    handleReconnection(event);
                }
            };

        } catch (error) {
            console.error(`WebSocketTransport: Failed to create WebSocket connection to ${url}:`, error);
            updateStatus('closed');
            options.onClose?.({ code: 1006, reason: `Failed to create connection: ${error instanceof Error ? error.message : String(error)}`, wasClean: false } as CloseEvent);
            handleReconnection({ code: 1006 } as CloseEvent); // Attempt reconnect even on creation error
        }
    }

    // --- zenQueryTransport Implementation ---

    const transport: zenQueryTransport = {
        request: (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
            return new Promise((resolve, reject) => {
                if (status !== 'open') {
                    return reject(new zenQueryClientError('Connection not open', 'CONNECTION_CLOSED'));
                }
                // Assign ID if not present (though client should usually add it)
                if (!message.id) {
                    message.id = generateId();
                }
                pendingRequests.set(message.id, { resolve, reject });
                if (!sendMessage(message)) {
                    pendingRequests.delete(message.id);
                    reject(new zenQueryClientError('Failed to send request', 'SEND_ERROR'));
                }
                // TODO: Add timeout for requests?
            });
        },

        subscribe: (message: SubscribeMessage) => {
            // Assign ID if not present
            if (!message.id) {
                message.id = generateId();
            }
            const subId = message.id;

            let dataQueue: Array<SubscriptionDataMessage | SubscriptionErrorMessage> = [];
            let resolvePromise: ((value: IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>) => void) | null = null;
            let isEnded = false;

            const pushData = (data: SubscriptionDataMessage) => {
                if (isEnded) return;
                if (resolvePromise) {
                    resolvePromise({ value: data, done: false });
                    resolvePromise = null;
                } else {
                    dataQueue.push(data);
                }
            };

            const pushError = (errorMsg: SubscriptionErrorMessage) => {
                if (isEnded) return;
                isEnded = true; // Error terminates the subscription
                if (resolvePromise) {
                    // Reject the pending promise
                    // How to best represent this? Throwing an error seems appropriate.
                    // Or yield the error message itself? Let's yield the message for now.
                    resolvePromise({ value: errorMsg, done: false }); // Yield error then end
                    // resolvePromise = null; // Keep it null after yielding error
                    // Need a way to signal the iterator should terminate *after* yielding error
                    // Maybe a special 'done' flag or rely on the consumer checking the type?
                    // Let's try yielding error, then ending normally.
                    setTimeout(() => end(), 0); // Schedule end after yielding error
                } else {
                    dataQueue.push(errorMsg); // Push error to queue
                    setTimeout(() => end(), 0); // Schedule end
                }
                activeSubscriptions.delete(subId);
            };

            const end = () => {
                if (isEnded) return;
                isEnded = true;
                if (resolvePromise) {
                    resolvePromise({ value: undefined, done: true });
                    resolvePromise = null;
                }
                // No need to delete from activeSubscriptions here, done by caller or error handler
            };

            const iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> = {
                next: (): Promise<IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>> => {
                    if (dataQueue.length > 0) {
                        const value = dataQueue.shift()!;
                        // If the yielded value is an error, the iterator should technically end.
                        // Let consumer handle the error type.
                        return Promise.resolve({ value: value, done: false });
                    }
                    if (isEnded) {
                        return Promise.resolve({ value: undefined, done: true });
                    }
                    return new Promise((resolve) => {
                        resolvePromise = resolve;
                    });
                },
                [Symbol.asyncIterator]() {
                    return this;
                },
                // Optional: Implement return() for cleanup when consumer breaks loop
                return(): Promise<IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>> {
                    console.log(`WebSocketTransport: Iterator return called for sub ${subId}`);
                    unsubscribeFn(); // Trigger unsubscribe on loop break
                    return Promise.resolve({ value: undefined, done: true });
                }
            };

            const unsubscribeFn: UnsubscribeFn = () => {
                if (activeSubscriptions.has(subId)) {
                    console.log(`WebSocketTransport: Unsubscribing from ${subId}`);
                    const unsubscribeMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: subId };
                    sendMessage(unsubscribeMessage);
                    end(); // End the local iterator
                    activeSubscriptions.delete(subId);
                }
            };

            // Store subscription details
            activeSubscriptions.set(subId, { pushData, pushError, end, originalMessage: message });

            // Send subscribe message if connected, otherwise it will be sent on reconnect
            if (status === 'open') {
                if (!sendMessage(message)) {
                    // Handle send failure immediately
                    pushError({ type: 'subscriptionError', id: subId, error: { message: 'Failed to send subscribe message' } });
                    activeSubscriptions.delete(subId); // Clean up if send failed
                }
            } else if (status !== 'connecting' && status !== 'reconnecting') {
                 // If not connected and not trying to connect, trigger error immediately
                 pushError({ type: 'subscriptionError', id: subId, error: { message: 'Cannot subscribe, not connected' } });
                 activeSubscriptions.delete(subId);
            }
             // If connecting/reconnecting, message will be sent onopen

            return { iterator, unsubscribe: unsubscribeFn };
        },

        // Optional methods
        get connected() {
            return status === 'open';
        },

        connect: () => {
            connectInternal();
        },

        disconnect: (code = 1000, reason = 'Normal closure') => {
            if (status !== 'open' && status !== 'connecting' && status !== 'reconnecting') {
                console.warn(`WebSocketTransport: Cannot disconnect while in state: ${status}`);
                return;
            }
            if (ws) {
                console.log(`WebSocketTransport: Closing connection with code ${code}...`);
                updateStatus('closing'); // Set state before calling close
                ws.close(code, reason);
            } else if (status === 'connecting' || status === 'reconnecting') {
                 // If connecting/reconnecting but ws is somehow null, just transition to closed
                 console.log(`WebSocketTransport: Connection attempt cancelled.`);
                 updateStatus('closed');
                 options.onClose?.({ code: code, reason: reason, wasClean: false } as CloseEvent);
            }
        },

        onConnectionChange: (handler: (connected: boolean) => void) => {
            connectionListeners.add(handler);
            // Immediately call handler with current state
            handler(status === 'open');
            return () => {
                connectionListeners.delete(handler);
            };
        },

        onDisconnect: (callback: () => void) => {
            disconnectListeners.add(callback);
            return () => {
                disconnectListeners.delete(callback);
            };
        },

        // send is used internally by server handler, not typically called by client
        // send: (message: SubscriptionDataMessage | SubscriptionErrorMessage | SubscriptionEndMessage) => {
        //     sendMessage(message);
        // },

        // onAckReceived is an optional callback property provided by the consumer,
        // not a method implemented by the transport itself.
        // The internal onmessage handler (line ~214) calls listeners added via this property.
        // Therefore, this method definition should be removed.

        requestMissingDeltas: (subscriptionId: number | string, fromSeq: number, toSeq: number) => {
            const message: RequestMissingMessage = {
                type: 'request_missing',
                id: subscriptionId,
                fromSeq,
                toSeq,
            };
            if (!sendMessage(message)) {
                console.error(`WebSocketTransport: Failed to send request_missing for sub ${subscriptionId}`);
            }
        },
    };

    // Optionally auto-connect on creation? Or require explicit connect()?
    // Let's require explicit connect for now.
    // connectInternal();

    return transport;
}

// Optional: Export server-side handler if needed in the same package (consider splitting?)
// export { createWebSocketHandler } from './server';
