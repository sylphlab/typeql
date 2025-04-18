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
    DEFAULT_MAX_RECONNECT_ATTEMPTS, // Added missing import
    DEFAULT_BASE_RECONNECT_DELAY_MS // Added missing import
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
    // Client calls (request/subscribe) should already have IDs.
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
            return false; // Indicate send failure
        }
    } else {
        console.warn(`[TypeQL WS Transport] WebSocket not open (state: ${state.ws?.readyState}). Message not sent:`, payload);
        // TODO: Implement offline queueing? For now, just fail.
        return false; // Indicate send failure
    }
}

/**
 * Schedules a WebSocket reconnection attempt with exponential backoff and jitter.
 * @param state - The shared connection state.
 * @param isImmediate - If true, attempts reconnection immediately. Defaults to false.
 */
export function scheduleReconnect(state: ConnectionState, isImmediate = false): void {
    const effectiveMaxReconnectAttempts = state.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS; // Use constant
    const effectiveBaseReconnectDelay = state.options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS; // Use constant

    if (state.reconnectAttempts >= effectiveMaxReconnectAttempts) {
        console.error(`[TypeQL WS Transport] Max reconnect attempts (${effectiveMaxReconnectAttempts}) reached. Giving up.`);
        // Consider a final notification?
        return;
    }

    if (state.reconnectTimeoutId) clearTimeout(state.reconnectTimeoutId); // Clear existing timer

    let delay = 0;
    if (!isImmediate) {
        // Calculate delay using exponential backoff with jitter
        const jitter = Math.random() * (RECONNECT_JITTER_FACTOR_MAX - RECONNECT_JITTER_FACTOR_MIN) + RECONNECT_JITTER_FACTOR_MIN;
        // Cap delay
        delay = Math.min(MAX_RECONNECT_DELAY_MS, effectiveBaseReconnectDelay * Math.pow(2, state.reconnectAttempts)) * jitter;
        state.reconnectAttempts++;
        console.log(`[TypeQL WS Transport] Scheduling reconnect attempt ${state.reconnectAttempts}/${effectiveMaxReconnectAttempts} in ${Math.round(delay)}ms...`);
    } else {
        console.log(`[TypeQL WS Transport] Scheduling immediate reconnect attempt ${state.reconnectAttempts + 1}/${effectiveMaxReconnectAttempts}...`);
        state.reconnectAttempts++; // Still count the immediate attempt
    }

    state.reconnectTimeoutId = setTimeout(() => {
        // Pass the state object to connectWebSocket
        connectWebSocket(state, true).catch(() => {
            // Errors are logged within connectWebSocket. scheduleReconnect will be called again from onclose/onerror.
        });
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
        if (message === null) return; // Skip messages that failed deserialization

        console.debug("[TypeQL WS Transport] Received message:", message); // Use debug for less noise

        // --- Request/Response Handling (ProcedureResultMessage) ---
        if (message && typeof message === 'object' && 'id' in message && 'result' in message && state.pendingRequests.has(message.id)) {
            const pending = state.pendingRequests.get(message.id)!;
            if (pending.timer) clearTimeout(pending.timer);
            const resultMsg = message as ProcedureResultMessage; // Type assertion
            // Check if it's an error response within the result
            if (resultMsg.result.type === 'error') {
                console.warn(`[TypeQL WS Transport] Received error for request ${message.id}:`, resultMsg.result.error);
                pending.reject(new Error(resultMsg.result.error.message || 'Procedure execution failed'));
            } else {
                pending.resolve(resultMsg); // Resolve with the full ProcedureResultMessage
            }
            state.pendingRequests.delete(message.id);
        }
        // --- Ack Handling ---
        else if (message && typeof message === 'object' && message.type === 'ack' && 'clientSeq' in message && 'serverSeq' in message) {
            const ackMessage = message as AckMessage;
            console.debug(`[TypeQL WS Transport] Received Ack for clientSeq: ${ackMessage.clientSeq}`);
            state.options.onAckReceived?.(ackMessage); // Call handler from options
        }
        // --- Subscription Message Handling ---
        else if (message && typeof message === 'object' && 'id' in message && state.activeSubscriptions.has(message.id)) {
            const subEntry = state.activeSubscriptions.get(message.id)!;
            // Ensure subscription is marked active if we receive data for it
            if (!subEntry.active) {
                subEntry.active = true;
                subEntry.handlers.onStart?.(); // Call onStart if defined
            }
            const subMsg = message as SubscriptionLifecycleMessage; // Type assertion

            switch (subMsg.type) {
                case 'subscriptionData':
                    subEntry.handlers.onData(subMsg);
                    break;
                case 'subscriptionError':
                    console.warn(`[TypeQL WS Transport] Received error for subscription ${message.id}:`, subMsg.error);
                    subEntry.handlers.onError(subMsg.error);
                    state.activeSubscriptions.delete(message.id); // Remove permanently on server error
                    break;
                case 'subscriptionEnd':
                    console.log(`[TypeQL WS Transport] Received end signal for subscription ${message.id}`);
                    subEntry.handlers.onEnd();
                    state.activeSubscriptions.delete(message.id); // Remove permanently on graceful end
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
} // *** End of handleMessage ***


/**
 * Establishes or re-establishes the WebSocket connection.
 * Manages connection state, event handlers, and resubscription logic.
 * @param state - The shared connection state.
 * @param isReconnectAttempt - Flag indicating if this is a reconnection attempt.
 * @returns A promise that resolves when the connection is open, or rejects on failure.
 */
export function connectWebSocket(state: ConnectionState, isReconnectAttempt = false): Promise<void> {
    // Avoid concurrent connection attempts or connecting when already open/closing
    if (state.connectionPromise) return state.connectionPromise; // Already connecting
    if (state.ws && (state.ws.readyState === OPEN || state.ws.readyState === CLOSING)) {
        return Promise.resolve(); // Already open or closing cleanly
    }

    console.log(`[TypeQL WS Transport] Attempting to connect to ${state.options.url}...`);
    // --- Proactive Cleanup ---
    if (state.ws) {
        console.log("[TypeQL WS Transport] Cleaning up previous WS instance before new connection attempt.");
        state.ws.onopen = state.ws.onerror = state.ws.onclose = state.ws.onmessage = null;
        if (state.ws.readyState === OPEN || state.ws.readyState === CONNECTING) {
            try { state.ws.close(CLOSE_CODE_GOING_AWAY, "Starting new connection attempt"); } catch { /* ignore */ }
        }
        state.ws = null;
    }
    // --- End Proactive Cleanup ---

    // Clear any pending reconnect timer *before* starting the new attempt
    if (state.reconnectTimeoutId) clearTimeout(state.reconnectTimeoutId);
    state.reconnectTimeoutId = undefined;

    try {
        // Use the implementation provided in options or the default
        state.ws = new state.WebSocketImplementation(state.options.url) as WebSocketLike;
    } catch (error) {
        console.error("[TypeQL WS Transport] Failed to instantiate WebSocket:", error);
        state.connectionPromise = null; // Reset promise
        scheduleReconnect(state); // Schedule next attempt
        return Promise.reject(error); // Reject the current attempt
    }

    updateConnectionStatus(state, false); // Mark as not connected (or connecting)

    state.connectionPromise = new Promise<void>((resolve, reject) => {
        if (!state.ws) return reject(new Error("WebSocket instance became null unexpectedly")); // Guard

        const handleOpen = () => {
            console.log(`[TypeQL WS Transport] Successfully connected to ${state.options.url}`);
            state.reconnectAttempts = 0; // Reset attempts on success
            updateConnectionStatus(state, true);
            const currentPromise = state.connectionPromise; // Capture before clearing
            state.connectionPromise = null; // Clear promise *before* resolving

            // Resubscribe logic
            if (isReconnectAttempt) {
                console.log("[TypeQL WS Transport] Re-establishing active subscriptions...");
                state.activeSubscriptions.forEach((subEntry, subId) => {
                    if (!subEntry.active) { // Resubscribe if marked inactive
                        console.log(`[TypeQL WS Transport] Resending subscription request for ID: ${subId}`);
                        if (sendMessage(state, subEntry.message)) {
                            // Don't mark active here, wait for onStart or first data
                            // subEntry.active = true; // Handled by handleMessage or onStart
                        } else {
                            console.error(`[TypeQL WS Transport] Failed to resend subscription message for ID: ${subId} after reconnect.`);
                            subEntry.handlers.onError({ message: "Failed to resubscribe after reconnect" });
                            // Keep inactive, maybe remove? For now, keep inactive.
                            // state.activeSubscriptions.delete(subId);
                        }
                    }
                });
            }
            // Only resolve the promise that corresponds to *this* connection attempt
            // Check if the promise reference is still the same one we created for this attempt
            if (state.connectionPromise === null) { // Check if it was cleared by this handler
                 resolve();
            } else {
                 console.warn("[TypeQL WS Transport] Connection promise mismatch during open, likely superseded.");
                 // If another connection attempt started, reject this one? Or just let it hang?
                 // Rejecting seems safer to avoid dangling promises.
                 reject(new Error("Connection attempt superseded by a newer one during open."));
            }
        };

        const handleError = (event: any) => {
            console.error("[TypeQL WS Transport] WebSocket error:", event?.message || event?.type || event);
            updateConnectionStatus(state, false);
            const error = new Error(`WebSocket error: ${event?.message || event?.type || 'Unknown error'}`);
            state.disconnectListeners.forEach(cb => cb());
            const currentPromise = state.connectionPromise; // Capture before clearing
            // Clean up before rejecting/scheduling reconnect
            if(state.ws) { state.ws.onopen = state.ws.onerror = state.ws.onclose = state.ws.onmessage = null; state.ws = null; }
            state.connectionPromise = null; // Clear promise *before* rejecting or scheduling
            // Only reject the promise that corresponds to *this* connection attempt
            // Check if the promise reference is still the same one we created for this attempt
            if (currentPromise && state.connectionPromise === null) { // Check if it was cleared by this handler
                 reject(error);
            } else {
                 console.warn("[TypeQL WS Transport] Connection promise mismatch during error, likely superseded.");
            }
            scheduleReconnect(state); // Schedule the next attempt
        };

        const handleClose = (event: any) => {
            console.log(`[TypeQL WS Transport] Disconnected from ${state.options.url} (Code: ${event?.code}, Reason: ${event?.reason})`);
            updateConnectionStatus(state, false);
            state.disconnectListeners.forEach(cb => cb());
            const error = new Error(`WebSocket closed (Code: ${event?.code}, Reason: ${event?.reason})`);

            // Reject pending requests immediately
            state.pendingRequests.forEach(({ reject: rejectRequest, timer }) => {
                if (timer) clearTimeout(timer);
                rejectRequest(error);
            });
            state.pendingRequests.clear();

            // Mark active subscriptions as inactive, but don't remove yet.
            state.activeSubscriptions.forEach((subEntry) => {
                subEntry.active = false;
            });

            const currentPromise = state.connectionPromise; // Capture before clearing
            // Clean up WS instance and promise
            if(state.ws) { state.ws.onopen = state.ws.onerror = state.ws.onclose = state.ws.onmessage = null; state.ws = null; }
            state.connectionPromise = null; // Clear promise *before* potentially scheduling reconnect

            // Reject the connection promise *if* it was still pending (i.e., failed during initial connection)
            // Only reject the promise that corresponds to *this* connection attempt
            // Check if the promise reference is still the same one we created for this attempt
            if (currentPromise && state.connectionPromise === null) { // Check if it was cleared by this handler
                 reject(error);
            } else {
                 console.warn("[TypeQL WS Transport] Connection promise mismatch during close, likely superseded.");
            }

            // Attempt to reconnect ONLY if it wasn't a clean close
            if (event?.code !== CLOSE_CODE_NORMAL) {
                scheduleReconnect(state);
            } else {
                console.log("[TypeQL WS Transport] Clean disconnect. Auto-reconnect disabled.");
                state.reconnectAttempts = state.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS; // Prevent accidental reconnects later
            }
        };

        // Assign handlers
        if (!state.ws) {
            state.connectionPromise = null; // Clear promise
            return reject(new Error("WebSocket instance became null before assigning handlers"));
        }
        state.ws.onopen = handleOpen;
        state.ws.onerror = handleError;
        state.ws.onclose = handleClose;
        // Pass state to handleMessage
        state.ws.onmessage = (event) => handleMessage(state, event);
    }); // *** End of new Promise() constructor ***

    return state.connectionPromise;
} // *** End of connectWebSocket ***


/**
 * Disconnects the WebSocket connection cleanly.
 * Clears pending requests, subscriptions, and prevents automatic reconnection.
 * @param state - The shared connection state.
 * @param code - The close code to send. Defaults to 1000 (Normal Closure).
 * @param reason - The close reason string. Defaults to "Client disconnecting".
 */
export function disconnectWebSocket(state: ConnectionState, code = CLOSE_CODE_NORMAL, reason = "Client disconnecting"): void {
    console.log(`[TypeQL WS Transport] Disconnecting WebSocket (Code: ${code}, Reason: ${reason})...`);
    // Prevent scheduled reconnects if manually disconnecting
    if (state.reconnectTimeoutId) clearTimeout(state.reconnectTimeoutId);
    state.reconnectTimeoutId = undefined;
    state.reconnectAttempts = state.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect

    // Reject pending requests immediately
    const disconnectError = new Error(`Transport disconnected by user (Code: ${code}, Reason: ${reason})`);
    state.pendingRequests.forEach(({ reject: rejectRequest, timer }) => {
        if (timer) clearTimeout(timer);
        rejectRequest(disconnectError);
    });
    state.pendingRequests.clear();

    // Clear active subscriptions immediately - no need to send unsubscribe messages
    // Call onEnd for any active iterators to signal completion.
    state.activeSubscriptions.forEach((subEntry) => {
        subEntry.handlers.onEnd(); // Signal end to the iterator
    });
    state.activeSubscriptions.clear();

    // Close WebSocket connection if it exists and isn't already closing/closed
    if (state.ws && state.ws.readyState !== CLOSING && state.ws.readyState !== CLOSED) {
        try {
            state.ws.close(code, reason);
        } catch (error) {
            console.error("[TypeQL WS Transport] Error during WebSocket close():", error);
        }
    }

    // Clean up state regardless of whether close() was called or errored
    state.ws = null;
    updateConnectionStatus(state, false); // Explicitly set connected state to false
    state.connectionPromise = null; // Clear any pending connection promise
    // Notify disconnect listeners *after* state is cleaned up
    state.disconnectListeners.forEach(cb => cb());
}