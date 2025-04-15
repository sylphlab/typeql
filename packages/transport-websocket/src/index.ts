// packages/transport-websocket/src/index.ts

import type {
    TypeQLTransport,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    SubscriptionHandlers,
    UnsubscribeFn,
    UnsubscribeMessage,
    SubscriptionLifecycleMessage // Import the union type for received messages
} from '@typeql/core';
import WebSocket from 'ws'; // Using 'ws' library

interface WebSocketTransportOptions {
    url: string;
    // TODO: Add options like protocols, retry logic, auto-reconnect etc.
    WebSocket?: typeof WebSocket | typeof globalThis.WebSocket; // Allow passing custom WebSocket implementation (e.g., browser vs node)
    serializer?: (data: any) => string; // Custom serializer
    deserializer?: (data: string | Buffer | ArrayBuffer | Buffer[]) => any; // Custom deserializer
}

// Default serializer/deserializer
const defaultSerializer = (data: any): string => JSON.stringify(data);
const defaultDeserializer = (data: string | Buffer | ArrayBuffer | Buffer[]): any => {
    if (typeof data === 'string') {
        return JSON.parse(data);
    }
    // Handle binary data if necessary - for now assume string
    console.warn("[TypeQL WS Transport] Received non-string data, deserialization might fail.");
    return JSON.parse(data.toString());
};


export function createWebSocketTransport(opts: WebSocketTransportOptions): TypeQLTransport {
    const {
        url,
        WebSocket: WebSocketImplementation = WebSocket, // Default to 'ws' library
        serializer = defaultSerializer,
        deserializer = defaultDeserializer,
    } = opts;

    console.log(`[TypeQL WS Transport] Creating transport for URL: ${url}`);

    let ws: WebSocket | globalThis.WebSocket | null = null;
    let connectionPromise: Promise<void> | null = null;
    let isConnected = false;
    let reconnectTimeout: NodeJS.Timeout | number | undefined;
    const connectionChangeListeners = new Set<(connected: boolean) => void>();

    // Store pending requests (query/mutation) waiting for a response
    const pendingRequests = new Map<string | number, { resolve: (result: ProcedureResultMessage) => void; reject: (reason?: any) => void }>();
    // Store active subscriptions and their handlers
    const activeSubscriptions = new Map<string | number, SubscriptionHandlers>();

    function updateConnectionStatus(newStatus: boolean) {
        if (isConnected !== newStatus) {
            isConnected = newStatus;
            console.log(`[TypeQL WS Transport] Connection status changed: ${isConnected}`);
            connectionChangeListeners.forEach(listener => listener(isConnected));
        }
    }

    function sendMessage(payload: any) {
        if (ws?.readyState === WebSocketImplementation.OPEN) {
            try {
                const serialized = serializer(payload);
                ws.send(serialized);
            } catch (error) {
                 console.error("[TypeQL WS Transport] Failed to serialize or send message:", error, payload);
            }
        } else {
            console.warn("[TypeQL WS Transport] WebSocket not open. Message not sent:", payload);
            // TODO: Queue message or handle error?
        }
    }

    function connectWebSocket() {
         // Avoid reconnecting if already connected or connecting
         if (ws || connectionPromise) return connectionPromise || Promise.resolve();

        console.log(`[TypeQL WS Transport] Connecting to ${url}...`);
        ws = new WebSocketImplementation(url);
        updateConnectionStatus(false); // Mark as connecting

        connectionPromise = new Promise<void>((resolve, reject) => {
            ws!.onopen = () => {
                console.log(`[TypeQL WS Transport] Connected to ${url}`);
                updateConnectionStatus(true);
                 connectionPromise = null; // Reset connection promise
                resolve();
                 // TODO: Resend pending requests/subscriptions if implementing auto-reconnect
            };

            ws!.onerror = (event: WebSocket.ErrorEvent) => { // Add type
                console.error("[TypeQL WS Transport] WebSocket error:", event.message); // Log specific message
                updateConnectionStatus(false);
                connectionPromise = null;
                ws = null; // Clear instance on error
                reject(new Error("WebSocket connection error"));
                 // TODO: Implement retry logic? scheduleReconnect();
            };

            ws!.onclose = (event: WebSocket.CloseEvent) => { // Add type
                console.log(`[TypeQL WS Transport] Disconnected from ${url} (Code: ${event.code}, Reason: ${event.reason})`);
                updateConnectionStatus(false);
                connectionPromise = null;
                ws = null; // Clear instance on close

                 // Reject pending requests on close
                 pendingRequests.forEach(({ reject }) => reject(new Error("WebSocket closed")));
                 pendingRequests.clear();
                 // Notify active subscriptions of error/end?
                 activeSubscriptions.forEach(handlers => handlers.onError({ message: "WebSocket closed" }));
                 // Don't clear activeSubscriptions here if reconnect is planned

                 // TODO: Implement retry logic? scheduleReconnect();
            };

            ws!.onmessage = (event: WebSocket.MessageEvent) => { // Add type
                try {
                    // event.data can be string, Buffer, ArrayBuffer etc. Deserializer should handle it.
                    const message = deserializer(event.data);
                    console.log("[TypeQL WS Transport] Received message:", message);

                    // Check if it's a response to a pending request
                    if ('id' in message && 'result' in message && pendingRequests.has(message.id)) {
                         const { resolve } = pendingRequests.get(message.id)!;
                         resolve(message as ProcedureResultMessage);
                         pendingRequests.delete(message.id);
                    }
                    // Check if it's related to an active subscription
                    else if ('id' in message && ('data' in message || 'error' in message || message.type === 'subscriptionEnd') && activeSubscriptions.has(message.id)) {
                         const handlers = activeSubscriptions.get(message.id)!;
                         const subMsg = message as SubscriptionLifecycleMessage;

                         if (subMsg.type === 'subscriptionData') {
                             handlers.onData(subMsg); // Pass the whole message
                         } else if (subMsg.type === 'subscriptionError') {
                             handlers.onError(subMsg.error);
                             activeSubscriptions.delete(message.id); // Remove on error
                         } else if (subMsg.type === 'subscriptionEnd') {
                             handlers.onEnd();
                             activeSubscriptions.delete(message.id); // Remove on normal end
                         }
                    } else {
                         console.warn("[TypeQL WS Transport] Received uncorrelated or unknown message:", message);
                    }

                } catch (error) {
                    console.error("[TypeQL WS Transport] Failed to deserialize or process message:", error, event.data);
                }
            };
        });
        return connectionPromise;
    }

     function disconnectWebSocket() {
         if (reconnectTimeout) clearTimeout(reconnectTimeout);
         reconnectTimeout = undefined;
         if (ws) {
             console.log("[TypeQL WS Transport] Closing WebSocket connection...");
             ws.close();
             ws = null; // Ensure ws is cleared immediately
             updateConnectionStatus(false);
         }
         connectionPromise = null;
     }

     // TODO: Implement reconnect logic if desired
     // function scheduleReconnect() { ... }


    const transport: TypeQLTransport = {
        request: async (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
             await (connectionPromise || connectWebSocket()); // Ensure connection exists or is being established
             if (!ws || ws.readyState !== WebSocketImplementation.OPEN) {
                 throw new Error("WebSocket not connected for request.");
             }

             return new Promise((resolve, reject) => {
                 pendingRequests.set(message.id, { resolve, reject });
                 sendMessage(message);
                 // TODO: Add timeout for requests?
             });
        },
        subscribe: (message: SubscribeMessage, handlers: SubscriptionHandlers): UnsubscribeFn => {
             // Ensure connection exists or is being established
             (connectionPromise || connectWebSocket())?.then(() => {
                 if (ws?.readyState === WebSocketImplementation.OPEN) {
                      activeSubscriptions.set(message.id, handlers);
                      sendMessage(message);
                      // TODO: Server should ideally confirm subscription start. Handlers.onStart?
                 } else {
                      // Handle case where connection failed before subscribe could be sent
                      handlers.onError({ message: "WebSocket not connected for subscription." });
                      // Optionally try to queue subscribe request on reconnect?
                 }
             }).catch(err => {
                 handlers.onError({ message: `WebSocket connection failed: ${err.message}` });
             });


             // Return the unsubscribe function
             return () => {
                 if (activeSubscriptions.has(message.id)) {
                     console.log(`[TypeQL WS Transport] Unsubscribing (ID: ${message.id})`);
                     activeSubscriptions.delete(message.id);
                     const unsubscribeMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: message.id };
                     sendMessage(unsubscribeMessage);
                 }
             };
        },
        connect: connectWebSocket,
        disconnect: disconnectWebSocket,
        get connected() {
             return isConnected;
        },
        onConnectionChange: (handler) => {
             connectionChangeListeners.add(handler);
             return () => connectionChangeListeners.delete(handler);
        }
    };

    // Initiate connection eagerly? Or wait for first request/subscribe? Eager for now.
    connectWebSocket();

    return transport;
}

console.log("@typeql/transport-websocket loaded");
