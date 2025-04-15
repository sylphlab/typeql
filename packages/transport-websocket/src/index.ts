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
    requestTimeoutMs?: number; // Optional request timeout
    maxReconnectAttempts?: number; // Max reconnect attempts
    baseReconnectDelayMs?: number; // Base delay for reconnect
}

// Default serializer/deserializer - Ensure errors are handled
const defaultSerializer = (data: any): string => JSON.stringify(data);
const defaultDeserializer = (data: string | Buffer | ArrayBuffer | Buffer[]): any => {
    let dataString: string | undefined;
    try {
        if (typeof data === 'string') {
            dataString = data;
        } else if (Buffer.isBuffer(data)) {
            // Handle Node.js Buffer
            dataString = data.toString('utf-8');
        } else if (data instanceof ArrayBuffer) {
            // Handle Browser ArrayBuffer
            dataString = new TextDecoder().decode(data);
         } else if (Array.isArray(data)) {
             // Handle ws Buffer[] case
             const buffers = data as Buffer[];
             dataString = Buffer.concat(buffers).toString('utf-8');
         } else {
             // Fallback for any other type not explicitly handled
            console.warn("[TypeQL WS Transport] Received unexpected data type, attempting String() conversion:", typeof data);
            dataString = String(data); // Use String() for safer conversion of primitives or objects with toString
        }

        if (dataString === undefined) {
             // This should ideally not happen with the String() fallback, but safety first
             throw new Error("Could not convert received data to string");
        }

        return JSON.parse(dataString);
    } catch (error) {
        console.error("[TypeQL WS Transport] Deserialization error:", error, dataString ?? data); // Log original data on error if possible
         return null; // Explicitly return null on error
     }
 }; // *** End of defaultDeserializer ***

 // Minimal WebSocket-like interface for compatibility across environments
 interface WebSocketLike {
     readonly readyState: number;
     send(data: string | Buffer | ArrayBuffer | Buffer[]): void;
     close(code?: number, reason?: string): void;
     onopen: (() => void) | null;
     onerror: ((event: any) => void) | null; // Use 'any' for broad compatibility
     onclose: ((event: any) => void) | null;
     onmessage: ((event: any) => void) | null;
 }

 // Constants for readyState (aligns with browser and 'ws')
 const CONNECTING = 0;
 const OPEN = 1;
 const CLOSING = 2;
 const CLOSED = 3;


 export function createWebSocketTransport(opts: WebSocketTransportOptions): TypeQLTransport {
     const {
         url,
         WebSocket: WebSocketImplementation = WebSocket, // Default to 'ws' library
         serializer = defaultSerializer,
         deserializer = defaultDeserializer,
     } = opts;

     console.log(`[TypeQL WS Transport] Creating transport for URL: ${url}`);

     let ws: WebSocketLike | null = null; // Use WebSocketLike interface
     let connectionPromise: Promise<void> | null = null;
     let isConnected = false;
     let reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined; // Use correct timer type
     const connectionChangeListeners = new Set<(connected: boolean) => void>();

     // Store pending requests (query/mutation) waiting for a response
     const pendingRequests = new Map<string | number, { resolve: (result: ProcedureResultMessage) => void; reject: (reason?: any) => void; timer?: ReturnType<typeof setTimeout> }>();
     // Store active subscriptions, their handlers, original message, and active status
     interface ActiveSubscriptionEntry {
         message: SubscribeMessage;
         handlers: SubscriptionHandlers;
         active: boolean; // Indicates if currently active (vs. temporarily inactive during reconnect)
     }
     const activeSubscriptions = new Map<string | number, ActiveSubscriptionEntry>();

     // --- Connection Status ---
     function updateConnectionStatus(newStatus: boolean) {
         if (isConnected !== newStatus) {
             isConnected = newStatus;
             console.log(`[TypeQL WS Transport] Connection status changed: ${isConnected}`);
             connectionChangeListeners.forEach(listener => listener(isConnected));
         }
     }

     function sendMessage(payload: any): boolean {
         // Ensure payload has an ID for correlation if not present
         // Client calls (request/subscribe) should already have IDs.
         if (!payload.id) {
             // Use a prefix for client-generated IDs if needed, or assume server handles missing IDs.
             // For now, let's rely on client generating IDs for its messages.
             console.warn("[TypeQL WS Transport] Message sent without ID:", payload);
             // payload.id = `client:${messageIdCounter++}`; // Example if needed
         }

         if (ws?.readyState === OPEN) { // Use constant
             try {
                 const serialized = serializer(payload);
                 ws.send(serialized);
                 console.log("[TypeQL WS Transport] Sent message:", payload.type, payload.id);
                 return true;
             } catch (error) {
                 console.error("[TypeQL WS Transport] Failed to serialize or send message:", error, payload);
                 return false; // Indicate send failure
             }
         } else {
             console.warn(`[TypeQL WS Transport] WebSocket not open (state: ${ws?.readyState}). Message not sent:`, payload);
             // TODO: Implement offline queueing? For now, just fail.
             return false; // Indicate send failure
         }
     }

     // --- Reconnect Logic ---
     const effectiveMaxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
     const effectiveBaseReconnectDelay = opts.baseReconnectDelayMs ?? 1000;
     let reconnectAttempts = 0;

     function scheduleReconnect(isImmediate = false) {
         if (reconnectAttempts >= effectiveMaxReconnectAttempts) {
              console.error(`[TypeQL WS Transport] Max reconnect attempts (${effectiveMaxReconnectAttempts}) reached. Giving up.`);
              // Consider a final notification?
              return;
         }

         if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId); // Clear existing timer

         let delay = 0;
         if (!isImmediate) {
             // Calculate delay using exponential backoff with jitter
             const jitter = Math.random() * 0.3 + 0.85; // 0.85 - 1.15
              // Cap delay at 30 seconds
             delay = Math.min(30000, effectiveBaseReconnectDelay * Math.pow(2, reconnectAttempts)) * jitter;
             reconnectAttempts++;
             console.log(`[TypeQL WS Transport] Scheduling reconnect attempt ${reconnectAttempts}/${effectiveMaxReconnectAttempts} in ${Math.round(delay)}ms...`);
         } else {
              console.log(`[TypeQL WS Transport] Scheduling immediate reconnect attempt ${reconnectAttempts + 1}/${effectiveMaxReconnectAttempts}...`);
              reconnectAttempts++; // Still count the immediate attempt
         }

          reconnectTimeoutId = setTimeout(() => {
               connectWebSocket(true).catch(() => { // Pass flag indicating it's a reconnect attempt
                   // Errors are logged within connectWebSocket. scheduleReconnect will be called again from onclose/onerror.
               });
          }, delay);
     }


     // --- WebSocket Connection Management ---

     function connectWebSocket(isReconnectAttempt = false): Promise<void> {
         // Avoid concurrent connection attempts or connecting when already open/closing
         if (connectionPromise) return connectionPromise; // Already connecting
         if (ws && (ws.readyState === OPEN || ws.readyState === CLOSING)) {
              return Promise.resolve(); // Already open or closing cleanly
         }

         console.log(`[TypeQL WS Transport] Attempting to connect to ${url}...`);
         // Clear any pending reconnect timer *before* starting the new attempt
         if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
         reconnectTimeoutId = undefined;

         try {
             ws = new WebSocketImplementation(url) as WebSocketLike;
         } catch (error) {
              console.error("[TypeQL WS Transport] Failed to instantiate WebSocket:", error);
              connectionPromise = null; // Reset promise
              scheduleReconnect(); // Schedule next attempt
              return Promise.reject(error); // Reject the current attempt
         }

         updateConnectionStatus(false); // Mark as not connected (or connecting)

         connectionPromise = new Promise<void>((resolve, reject) => {
              if (!ws) return reject(new Error("WebSocket instance became null unexpectedly")); // Guard

              const handleOpen = () => {
                  console.log(`[TypeQL WS Transport] Successfully connected to ${url}`);
                  reconnectAttempts = 0; // Reset attempts on success
                  updateConnectionStatus(true);
                  connectionPromise = null; // Clear promise *before* resolving

                  // Resubscribe logic
                  if (isReconnectAttempt) {
                      console.log("[TypeQL WS Transport] Re-establishing active subscriptions...");
                      activeSubscriptions.forEach((subEntry, subId) => {
                          if (!subEntry.active) { // Resubscribe if marked inactive
                              console.log(`[TypeQL WS Transport] Resending subscription request for ID: ${subId}`);
                              if (sendMessage(subEntry.message)) {
                                   subEntry.active = true; // Mark as active again
                              } else {
                                   console.error(`[TypeQL WS Transport] Failed to resend subscription message for ID: ${subId} after reconnect.`);
                                   // Keep inactive, will retry on next connection or manual intervention needed?
                                   // Maybe notify handler?
                                   subEntry.handlers.onError({ message: "Failed to resubscribe after reconnect" });
                                   // Consider removing? For now, keep inactive.
                                   // activeSubscriptions.delete(subId);
                              }
                          }
                      });
                  }
                  resolve(); // Resolve the connection promise
              };

              const handleError = (event: any) => {
                  console.error("[TypeQL WS Transport] WebSocket error:", event?.message || event?.type || event);
                  updateConnectionStatus(false);
                  const error = new Error(`WebSocket error: ${event?.message || event?.type || 'Unknown error'}`);
                  // Clean up before rejecting/scheduling reconnect
                  if(ws) { ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null; ws = null; }
                  connectionPromise = null; // Clear promise *before* rejecting or scheduling
                  reject(error); // Reject the current connection attempt's promise
                  scheduleReconnect(); // Schedule the next attempt
              };

              const handleClose = (event: any) => {
                  console.log(`[TypeQL WS Transport] Disconnected from ${url} (Code: ${event?.code}, Reason: ${event?.reason})`);
                  updateConnectionStatus(false);
                  const wasConnectedBeforeClose = isConnected; // Check previous status
                  const error = new Error(`WebSocket closed (Code: ${event?.code}, Reason: ${event?.reason})`);

                  // Reject pending requests immediately
                  pendingRequests.forEach(({ reject: rejectRequest, timer }) => {
                      if (timer) clearTimeout(timer);
                      rejectRequest(error);
                  });
                  pendingRequests.clear();

                  // Mark active subscriptions as inactive, but don't remove yet.
                  // Avoid calling onError here directly, let consumer react to connection status change.
                  activeSubscriptions.forEach((subEntry) => {
                      subEntry.active = false;
                  });

                  // Clean up WS instance and promise
                  if(ws) { ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null; ws = null; }
                  const existingPromise = connectionPromise; // Capture promise before clearing
                  connectionPromise = null; // Clear promise *before* potentially scheduling reconnect

                  // Reject the connection promise *if* it was still pending (i.e., failed during initial connection)
                  if (existingPromise) {
                      reject(error);
                  }

                  // Attempt to reconnect ONLY if it wasn't a clean close (code 1000)
                  // and if reconnect attempts are not exhausted.
                  if (event?.code !== 1000) {
                      scheduleReconnect();
                  } else {
                       console.log("[TypeQL WS Transport] Clean disconnect. Auto-reconnect disabled.");
                       reconnectAttempts = effectiveMaxReconnectAttempts; // Prevent accidental reconnects later
                  }
              };

              const handleMessage = (event: any) => {
                  try {
                      const message = deserializer(event.data);
                      if (message === null) return; // Skip messages that failed deserialization

                      console.debug("[TypeQL WS Transport] Received message:", message); // Use debug for less noise

                      // --- Request/Response Handling ---
                      if (message && typeof message === 'object' && 'id' in message && ('result' in message || 'error' in message) && pendingRequests.has(message.id)) {
                          const pending = pendingRequests.get(message.id)!;
                          if (pending.timer) clearTimeout(pending.timer);
                          // Check if it's an error response
                          if ('error' in message && message.error) {
                               console.warn(`[TypeQL WS Transport] Received error for request ${message.id}:`, message.error);
                               pending.reject(new Error(message.error.message || 'Procedure execution failed'));
                          } else {
                               pending.resolve(message as ProcedureResultMessage); // Assume ProcedureResultMessage structure if no error
                          }
                          pendingRequests.delete(message.id);
                      }
                      // --- Subscription Message Handling ---
                      else if (message && typeof message === 'object' && 'id' in message && activeSubscriptions.has(message.id)) {
                          const subEntry = activeSubscriptions.get(message.id)!;
                          // Ensure subscription is marked active if we receive data for it
                          // (Might happen if reconnect was very fast and server sent data before client resent subscribe)
                          subEntry.active = true;
                          const subMsg = message as SubscriptionLifecycleMessage; // Type assertion

                          switch (subMsg.type) {
                              case 'subscriptionData':
                                  subEntry.handlers.onData(subMsg);
                                  break;
                              case 'subscriptionError':
                                  console.warn(`[TypeQL WS Transport] Received error for subscription ${message.id}:`, subMsg.error);
                                  subEntry.handlers.onError(subMsg.error);
                                  activeSubscriptions.delete(message.id); // Remove permanently on server error
                                  break;
                              case 'subscriptionEnd':
                                  console.log(`[TypeQL WS Transport] Received end signal for subscription ${message.id}`);
                                  subEntry.handlers.onEnd();
                                  activeSubscriptions.delete(message.id); // Remove permanently on graceful end
                                  break;
                               default:
                                  console.warn("[TypeQL WS Transport] Received unknown message type for active subscription:", message);
                          }
                      } else { // This else corresponds to the outer 'if message && typeof message === object' checks
                          console.warn("[TypeQL WS Transport] Received uncorrelated or unknown message:", message);
                      }
                  } catch (error) { // This catch corresponds to the try block starting before deserializer(event.data)
                      console.error("[TypeQL WS Transport] Failed to process received message:", error, event?.data);
                  }
              }; // *** End of handleMessage ***

              // Assign handlers
              if (!ws) {
                   // Should not happen if guard at the start is effective, but for safety:
                   connectionPromise = null; // Clear promise
                   return reject(new Error("WebSocket instance became null before assigning handlers"));
              }
              ws.onopen = handleOpen;
              ws.onerror = handleError;
              ws.onclose = handleClose;
              ws.onmessage = handleMessage;
         }); // *** End of new Promise() constructor ***

         // Return the promise created by the new Promise() call
         return connectionPromise;
     } // *** End of connectWebSocket ***


     // --- Disconnect WebSocket ---
     function disconnectWebSocket(code = 1000, reason = "Client disconnecting") {
         console.log(`[TypeQL WS Transport] Disconnecting WebSocket (Code: ${code}, Reason: ${reason})...`);
         // Prevent scheduled reconnects if manually disconnecting
          if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
          reconnectTimeoutId = undefined;
          reconnectAttempts = effectiveMaxReconnectAttempts; // Prevent auto-reconnect after manual disconnect

          // Reject pending requests immediately
          const disconnectError = new Error(`Transport disconnected by user (Code: ${code}, Reason: ${reason})`);
          // Define the error type for clarity
          type PendingRequestEntry = { resolve: (result: ProcedureResultMessage) => void; reject: (reason?: any) => void; timer?: ReturnType<typeof setTimeout> };

          pendingRequests.forEach(({ reject: rejectRequest, timer }: PendingRequestEntry) => {
              if (timer) clearTimeout(timer);
              rejectRequest(disconnectError);
          });
          pendingRequests.clear();

          // Clear active subscriptions immediately - no need to send unsubscribe messages
          // as the connection is closing anyway. Don't notify handlers on manual disconnect.
          activeSubscriptions.clear();

          // Close WebSocket connection if it exists and isn't already closing/closed
          if (ws && ws.readyState !== CLOSING && ws.readyState !== CLOSED) {
              try {
                   ws.close(code, reason);
              } catch (error) {
                   console.error("[TypeQL WS Transport] Error during WebSocket close():", error);
              }
          }

          // Clean up state regardless of whether close() was called or errored
          ws = null;
          updateConnectionStatus(false); // Explicitly set connected state to false
          connectionPromise = null; // Clear any pending connection promise
      }


     // --- Transport Interface Implementation ---
     const transport: TypeQLTransport = {
         request: async (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
              // Ensure connection exists or is being established
              await (connectionPromise || connectWebSocket());
              // If still not connected after attempt, throw
              if (!ws || ws.readyState !== OPEN) {
                  throw new Error("WebSocket not connected for request.");
              }

              const requestTimeout = opts.requestTimeoutMs ?? 15000; // Default 15s timeout

              return new Promise((resolve, reject) => {
                  let timer: ReturnType<typeof setTimeout> | undefined;

                  const reqEntry = {
                      resolve,
                      reject: (reason?: any) => {
                           if (timer) clearTimeout(timer); // Clear timer on rejection
                           reject(reason);
                      },
                      timer: undefined as ReturnType<typeof setTimeout> | undefined,
                  };

                  if (requestTimeout > 0) {
                      reqEntry.timer = setTimeout(() => {
                          pendingRequests.delete(message.id);
                          reject(new Error(`Request timed out after ${requestTimeout}ms (ID: ${message.id})`));
                      }, requestTimeout);
                  }

                  pendingRequests.set(message.id, reqEntry);

                  if (!sendMessage(message)) {
                       // If send fails immediately, reject the promise
                       reqEntry.reject(new Error(`Failed to send request message immediately (ID: ${message.id})`));
                       pendingRequests.delete(message.id); // Clean up map
                  }
              });
         },

         subscribe: (message: SubscribeMessage, handlers: SubscriptionHandlers): UnsubscribeFn => {
              const subId = message.id;
              console.log(`[TypeQL WS Transport] Attempting to subscribe (ID: ${subId})`);

              // Store subscription details immediately, marked as inactive initially
              const subEntry: ActiveSubscriptionEntry = { message, handlers, active: false };
              activeSubscriptions.set(subId, subEntry);

              const connectAndSendSubscribe = async () => {
                  try {
                       await (connectionPromise || connectWebSocket()); // Ensure connection attempt happens
                       if (ws?.readyState === OPEN) {
                            if (sendMessage(message)) {
                                 subEntry.active = true; // Mark active on successful send
                                 console.log(`[TypeQL WS Transport] Subscribe message sent (ID: ${subId})`);
                                 // Consider adding handlers.onStart() if needed?
                            } else {
                                 throw new Error("Failed to send subscribe message"); // Throw if send fails
                            }
                       } else {
                            // If not open after connect attempt, keep inactive. Reconnect logic will handle it.
                            console.warn(`[TypeQL WS Transport] WebSocket not open after connect attempt for subscription ${subId}. Will retry on reconnect.`);
                       }
                      // Don't throw here, let reconnect handle it. Maybe notify?
                      // handlers.onError({ message: "WebSocket not immediately available" }); // Maybe too noisy
                  } catch (err: any) { // Added catch block for the try
                     // Catch errors during the *initial* connection or send attempt within this function
                     console.error(`[TypeQL WS Transport] Error during initial subscribe connection/send (ID: ${subId}):`, err);
                     handlers.onError({ message: `Subscription failed: ${err.message || err}` });
                     activeSubscriptions.delete(subId); // Remove if initial attempt fails catastrophically
                  }
              };

              // Invoke the function - no need for an additional .catch here now as it's handled inside
              connectAndSendSubscribe();
              /* // Removed the redundant .catch() here
              .catch(err => {
                  // Catch errors during the *initial* send attempt
                  console.error(`[TypeQL WS Transport] Error during initial subscribe attempt (ID: ${subId}):`, err);
                  handlers.onError({ message: `Subscription failed: ${err.message}` });
                  activeSubscriptions.delete(subId); // Remove if initial attempt fails catastrophically
              });
              */ // Added closing comment tag

              // Return the unsubscribe function
              return () => {
                   const currentSub = activeSubscriptions.get(subId);
                   if (currentSub) {
                       console.log(`[TypeQL WS Transport] Unsubscribing (ID: ${subId})`);
                       activeSubscriptions.delete(subId); // Remove from tracking immediately
                       // Attempt to send stop message only if currently connected and was active
                       if (ws?.readyState === OPEN && currentSub.active) {
                            const unsubscribeMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: subId };
                            sendMessage(unsubscribeMessage);
                       }
                   }
              };
         },

         connect: () => connectWebSocket(false), // Explicitly not a reconnect attempt
         disconnect: disconnectWebSocket,

         get connected() {
              return isConnected;
         },
         onConnectionChange: (handler) => {
              connectionChangeListeners.add(handler);
              return () => connectionChangeListeners.delete(handler);
         }
     }; // *** End of transport object ***

    // Initiate connection eagerly? Or wait for first request/subscribe? Eager for now.
    // Use void operator to explicitly ignore the promise result here if not needed
    void connectWebSocket().catch((error: any) => { // Added type annotation for error
        console.error("[TypeQL WS Transport] Initial connection failed:", error);
        // scheduleReconnect() should be called internally by connectWebSocket's error/close handlers
    });

    return transport;
} // *** End of createWebSocketTransport ***

console.log("@typeql/transport-websocket loaded");
