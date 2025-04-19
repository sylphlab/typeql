// packages/transport-websocket/src/connection.ts

import type {
    WebSocketLike,
    ConnectionState,
    ActiveSubscriptionEntry,
    PendingRequestEntry,
    ProcedureResultMessage,
    SubscriptionLifecycleMessage,
    AckMessage
} from './types';
import {
    CONNECTING,
    OPEN,
    CLOSING,
    CLOSED,
    MAX_RECONNECT_DELAY_MS,
    RECONNECT_JITTER_FACTOR_MIN,
    RECONNECT_JITTER_FACTOR_MAX,
    CLOSE_CODE_NORMAL,
    CLOSE_CODE_GOING_AWAY,
    DEFAULT_MAX_RECONNECT_ATTEMPTS,
    DEFAULT_BASE_RECONNECT_DELAY_MS
} from './constants';

/**
 * Updates the connection status and notifies listeners if the status changes.
 * @param state - The shared connection state.
 * @param newStatus - The new connection status (true for connected, false otherwise).
 */
export function updateConnectionStatus(state: ConnectionState, newStatus: boolean): void {
    if (state.isConnected !== newStatus) {
        state.isConnected = newStatus;
        console.log(`[TypeQL WS Transport] Connection status changed: ${state.isConnected}`);
        state.connectionChangeListeners.forEach(listener => listener(state.isConnected));
    }
}

/**
 * Sends a message payload over the WebSocket connection if it's open.
 * Serializes the payload using the configured serializer.
 * @param state - The shared connection state.
 * @param payload - The message payload to send.
 * @returns True if the message was sent successfully, false otherwise.
 */
export function sendMessage(state: ConnectionState, payload: any): boolean {
    if (!payload.id) {
        console.warn("[TypeQL WS Transport] Message sent without ID:", payload);
    }

    if (state.ws?.readyState === OPEN) {
        try {
            const serialized = state.serializer(payload);
            state.ws.send(serialized);
            console.log("[TypeQL WS Transport] Sent message:", payload.type, payload.id);
            return true;
        } catch (error) {
            console.error("[TypeQL WS Transport] Failed to serialize or send message:", error, payload);
            return false;
        }
    } else {
        console.warn(`[TypeQL WS Transport] WebSocket not open (state: ${state.ws?.readyState}). Message not sent:`, payload);
        return false;
    }
}

/**
 * Schedules a WebSocket reconnection attempt with exponential backoff and jitter.
 * @param state - The shared connection state.
 * @param isImmediate - If true, attempts reconnection immediately. Defaults to false.
 */
export function scheduleReconnect(state: ConnectionState, isImmediate = false): void {
    const effectiveMaxReconnectAttempts = state.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    const effectiveBaseReconnectDelay = state.options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS;

    if (state.reconnectAttempts >= effectiveMaxReconnectAttempts) {
        console.error(`[TypeQL WS Transport] Max reconnect attempts (${effectiveMaxReconnectAttempts}) reached. Giving up.`);
        return;
    }

    if (state.reconnectTimeoutId) clearTimeout(state.reconnectTimeoutId);

    let delay = 0;
    if (!isImmediate) {
        const jitter = Math.random() * (RECONNECT_JITTER_FACTOR_MAX - RECONNECT_JITTER_FACTOR_MIN) + RECONNECT_JITTER_FACTOR_MIN;
        delay = Math.min(MAX_RECONNECT_DELAY_MS, effectiveBaseReconnectDelay * Math.pow(2, state.reconnectAttempts)) * jitter;
        state.reconnectAttempts++;
        console.log(`[TypeQL WS Transport] Scheduling reconnect attempt ${state.reconnectAttempts}/${effectiveMaxReconnectAttempts} in ${Math.round(delay)}ms...`);
    } else {
        console.log(`[TypeQL WS Transport] Scheduling immediate reconnect attempt ${state.reconnectAttempts + 1}/${effectiveMaxReconnectAttempts}...`);
        state.reconnectAttempts++;
    }

    state.reconnectTimeoutId = setTimeout(() => {
        connectWebSocket(state, true).catch(() => {});
    }, delay);
}


/**
 * Handles incoming WebSocket messages, deserializing and routing them
 * to the appropriate handlers (request promises, subscription handlers, ack handler).
 * @param state - The shared connection state.
 * @param event - The WebSocket message event.
 */
function handleMessage(state: ConnectionState, event: any): void {
    try {
        const message = state.deserializer(event.data);
        if (message === null) return;

        console.debug("[TypeQL WS Transport] Received message:", message);

        if (message && typeof message === 'object' && 'id' in message && 'result' in message && state.pendingRequests.has(message.id)) {
            const pending = state.pendingRequests.get(message.id)!;
            if (pending.timer) clearTimeout(pending.timer);
            const resultMsg = message as ProcedureResultMessage;
            if (resultMsg.result.type === 'error') {
                console.warn(`[TypeQL WS Transport] Received error for request ${message.id}:`, resultMsg.result.error);
                pending.reject(new Error(resultMsg.result.error.message || 'Procedure execution failed'));
            } else {
                pending.resolve(resultMsg);
            }
            state.pendingRequests.delete(message.id);
        }
        else if (message && typeof message === 'object' && message.type === 'ack' && 'clientSeq' in message && 'serverSeq' in message) {
            const ackMessage = message as AckMessage;
            console.debug(`[TypeQL WS Transport] Received Ack for clientSeq: ${ackMessage.clientSeq}`);
            // Fix: Ensure handler is called if defined
            if (typeof state.options.onAckReceived === 'function') {
                state.options.onAckReceived(ackMessage);
            }
        }
        else if (message && typeof message === 'object' && 'id' in message && state.activeSubscriptions.has(message.id)) {
            const subEntry = state.activeSubscriptions.get(message.id)!;
            if (!subEntry.active) {
                subEntry.active = true;
                subEntry.handlers.onStart?.();
            }
            const subMsg = message as SubscriptionLifecycleMessage;

            switch (subMsg.type) {
                case 'subscriptionData':
                    subEntry.handlers.onData(subMsg);
                    break;
                case 'subscriptionError':
                    console.warn(`[TypeQL WS Transport] Received error for subscription ${message.id}:`, subMsg.error);
                    subEntry.handlers.onError(subMsg.error);
                    state.activeSubscriptions.delete(message.id);
                    break;
                case 'subscriptionEnd':
                    console.log(`[TypeQL WS Transport] Received end signal for subscription ${message.id}`);
                    subEntry.handlers.onEnd();
                    state.activeSubscriptions.delete(message.id);
                    break;
                default:
                    console.warn("[TypeQL WS Transport] Received unknown message type for active subscription:", message);
            }
        } else {
            console.warn("[TypeQL WS Transport] Received uncorrelated or unknown message:", message);
        }
    } catch (error) {
        console.error("[TypeQL WS Transport] Failed to process received message:", error, event?.data);
    }
}


/**
 * Establishes or re-establishes the WebSocket connection.
 * Manages connection state, event handlers, and resubscription logic.
 * @param state - The shared connection state.
 * @param isReconnectAttempt - Flag indicating if this is a reconnection attempt.
 * @returns A promise that resolves when the connection is open, or rejects on failure.
 */
export function connectWebSocket(state: ConnectionState, isReconnectAttempt = false): Promise<void> {
    if (state.connectionPromise) return state.connectionPromise;
    if (state.ws && (state.ws.readyState === OPEN || state.ws.readyState === CLOSING)) {
        return Promise.resolve();
    }

    console.log(`[TypeQL WS Transport] Attempting to connect to ${state.options.url}...`);
    // Cleanup moved to handleClose/handleError

    if (state.reconnectTimeoutId) clearTimeout(state.reconnectTimeoutId);
    state.reconnectTimeoutId = undefined;

    try {
        state.ws = new state.WebSocketImplementation(state.options.url) as WebSocketLike;
    } catch (error) {
        console.error("[TypeQL WS Transport] Failed to instantiate WebSocket:", error);
        state.connectionPromise = null;
        scheduleReconnect(state);
        return Promise.reject(error);
    }

    updateConnectionStatus(state, false);

    state.connectionPromise = new Promise<void>((resolve, reject) => {
        if (!state.ws) return reject(new Error("WebSocket instance became null unexpectedly"));

        const handleOpen = () => {
            console.log(`[TypeQL WS Transport] Successfully connected to ${state.options.url}`);
            state.reconnectAttempts = 0;
            updateConnectionStatus(state, true);
            const currentPromise = state.connectionPromise;
            state.connectionPromise = null;

            if (isReconnectAttempt) {
                console.log(`[TypeQL WS Transport] Re-establishing ${state.activeSubscriptions.size} subscriptions...`);
                const entriesToResubscribe = Array.from(state.activeSubscriptions.values());
                entriesToResubscribe.forEach((subEntry) => {
                    if (!subEntry.active) {
                        console.log(`[TypeQL WS Transport] Resending subscription request for ID: ${subEntry.message.id}`);
                        // Fix: Ensure sendMessage is called correctly
                        const sent = sendMessage(state, subEntry.message);
                        if (!sent) {
                            console.error(`[TypeQL WS Transport] Failed to resend subscription message for ID: ${subEntry.message.id} after reconnect.`);
                            subEntry.handlers.onError({ message: "Failed to resubscribe after reconnect" });
                        }
                    }
                });
            }

            // Resolve the promise *if* it's the one for this attempt
            if (currentPromise === state.connectionPromise) { // Check if it's still the same promise reference
                 resolve();
            } else if (state.connectionPromise === null) { // Correct check: If it was cleared by this handler
                 resolve();
            } else {
                 console.warn("[TypeQL WS Transport] Connection promise mismatch during open, likely superseded.");
                 reject(new Error("Connection attempt superseded by a newer one during open."));
            }
        };

        const handleError = (event: any) => {
            console.error("[TypeQL WS Transport] WebSocket error:", event?.message || event?.type || event);
            const error = new Error(`WebSocket error: ${event?.message || event?.type || 'Unknown error'}`);
            const currentPromise = state.connectionPromise;
            const wsInstanceOnError = state.ws;

            updateConnectionStatus(state, false);
            if (wsInstanceOnError) {
                wsInstanceOnError.onopen = wsInstanceOnError.onerror = wsInstanceOnError.onclose = wsInstanceOnError.onmessage = null;
            }
            if (state.ws === wsInstanceOnError) {
                state.ws = null;
            }
            if (state.connectionPromise === currentPromise) {
                state.connectionPromise = null;
            }

            // Reject the promise *if* it was the one associated with this failed attempt
            if (currentPromise && state.connectionPromise === null) {
                 reject(error);
            } else {
                 console.warn("[TypeQL WS Transport] Connection promise mismatch during error, likely superseded.");
            }

            state.disconnectListeners.forEach(cb => cb());
            scheduleReconnect(state);
        };

        const handleClose = (event: any) => {
            const code = event?.code ?? 1006;
            const reason = event?.reason ?? 'Unknown reason';
            console.log(`[TypeQL WS Transport] Disconnected from ${state.options.url} (Code: ${code}, Reason: ${reason})`);

            const error = new Error(`WebSocket closed (Code: ${code}, Reason: ${reason})`);
            const wasConnected = state.isConnected;
            const currentPromise = state.connectionPromise;
            const wsInstanceBeingClosed = state.ws;

            updateConnectionStatus(state, false);

            // Clean up handlers for the instance being closed
            if (wsInstanceBeingClosed) {
                 wsInstanceBeingClosed.onopen = wsInstanceBeingClosed.onerror = wsInstanceBeingClosed.onclose = wsInstanceBeingClosed.onmessage = null;
            }
            // Nullify state.ws only if it's the one that closed
            if (state.ws === wsInstanceBeingClosed) {
                state.ws = null;
            }

            // Clear connection promise *if* it belongs to this closing instance
            if (state.connectionPromise === currentPromise) {
                 state.connectionPromise = null;
            }

            // Reject pending requests
            state.pendingRequests.forEach(({ reject: rejectRequest, timer }) => {
                if (timer) clearTimeout(timer);
                rejectRequest(error);
            });
            state.pendingRequests.clear();

            // Mark subscriptions inactive
            state.activeSubscriptions.forEach((subEntry) => {
                subEntry.active = false;
            });

            // Call disconnect listeners *if status changed from connected*
            if (wasConnected) {
                 state.disconnectListeners.forEach(cb => cb());
            }

            // Reject the connection promise *if* it was pending for the instance being closed
            // Fix: Ensure rejection happens correctly
            if (currentPromise && state.connectionPromise === null) { // Check if it was cleared by this handler
                 console.log(`[TypeQL WS Transport] Rejecting connection promise for closed socket (Code: ${code})`);
                 reject(error);
            } else if (currentPromise) {
                 // If the promise wasn't cleared, it means a new attempt likely started.
                 // Don't reject the old promise, just warn.
                 console.warn("[TypeQL WS Transport] Connection promise mismatch during close, likely superseded (not rejecting).");
            }

             // Fix: Explicitly close the old socket instance *before* scheduling reconnect
             if (wsInstanceBeingClosed && wsInstanceBeingClosed.readyState !== CLOSED) {
                  try {
                      console.log(`[TypeQL WS Transport] Explicitly closing old instance in handleClose (Code: ${CLOSE_CODE_GOING_AWAY})`);
                      wsInstanceBeingClosed.close(CLOSE_CODE_GOING_AWAY, "Connection closed, attempting reconnect");
                  } catch { /* Ignore errors closing old socket */ }
             }

            // Schedule reconnect if not a clean close
            if (code !== CLOSE_CODE_NORMAL) {
                scheduleReconnect(state);
            } else {
                console.log("[TypeQL WS Transport] Clean disconnect. Auto-reconnect disabled.");
                state.reconnectAttempts = state.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
            }
        };

        if (!state.ws) {
            state.connectionPromise = null;
            return reject(new Error("WebSocket instance became null before assigning handlers"));
        }
        state.ws.onopen = handleOpen;
        state.ws.onerror = handleError;
        state.ws.onclose = handleClose;
        state.ws.onmessage = (event) => handleMessage(state, event);

    });

    return state.connectionPromise;
}


/**
 * Disconnects the WebSocket connection cleanly.
 * Clears pending requests, subscriptions, and prevents automatic reconnection.
 * @param state - The shared connection state.
 * @param code - The close code to send. Defaults to 1000 (Normal Closure).
 * @param reason - The close reason string. Defaults to "Client disconnecting".
 */
export function disconnectWebSocket(state: ConnectionState, code = CLOSE_CODE_NORMAL, reason = "Client disconnecting"): void {
    console.log(`[TypeQL WS Transport] Disconnecting WebSocket (Code: ${code}, Reason: ${reason})...`);
    if (state.reconnectTimeoutId) clearTimeout(state.reconnectTimeoutId);
    state.reconnectTimeoutId = undefined;
    state.reconnectAttempts = state.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

    const disconnectError = new Error(`Transport disconnected by user (Code: ${code}, Reason: ${reason})`);
    state.pendingRequests.forEach(({ reject: rejectRequest, timer }) => {
        if (timer) clearTimeout(timer);
        rejectRequest(disconnectError);
    });
    state.pendingRequests.clear();

    state.activeSubscriptions.forEach((subEntry) => {
        subEntry.handlers.onEnd();
    });
    state.activeSubscriptions.clear();

    if (state.ws && state.ws.readyState !== CLOSING && state.ws.readyState !== CLOSED) {
        try {
            state.ws.close(code, reason);
        } catch (error) {
            console.error("[TypeQL WS Transport] Error during WebSocket close():", error);
        }
    }

    state.ws = null;
    updateConnectionStatus(state, false);
    state.connectionPromise = null;
    state.disconnectListeners.forEach(cb => cb());
}