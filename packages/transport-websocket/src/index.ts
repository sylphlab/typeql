// packages/transport-websocket/src/index.ts

import WebSocket from 'ws'; // Default WebSocket implementation for Node.js
import type {
    TypeQLTransport,
    WebSocketTransportOptions,
    ConnectionState,
    PendingRequestEntry,
    ActiveSubscriptionEntry,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    UnsubscribeFn,
    SubscriptionDataMessage, // Import specific types needed for re-export
    SubscriptionErrorMessage,
    SubscriptionEndMessage,
    AckMessage,
    RequestMissingMessage,
    SubscriptionIteratorYield,
    SubscriptionResult,
} from './types';
import { defaultSerializer, defaultDeserializer } from './serialization';
import {
    connectWebSocket,
    disconnectWebSocket,
    updateConnectionStatus,
    sendMessage,
    scheduleReconnect,
} from './connection';
import { handleRequest } from './request';
import { handleSubscribe, requestMissingDeltas } from './subscription';

// Re-export core types for consumers
export type {
    TypeQLTransport,
    WebSocketTransportOptions,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    SubscriptionEndMessage,
    AckMessage,
    RequestMissingMessage,
    SubscriptionIteratorYield,
    SubscriptionResult,
} from './types';

/**
 * Creates a TypeQL transport layer over WebSockets.
 *
 * @param opts - Configuration options for the WebSocket transport.
 * @returns An instance of TypeQLTransport.
 */
export function createWebSocketTransport(opts: WebSocketTransportOptions): TypeQLTransport {
    // Determine the WebSocket implementation (Node vs Browser)
    // Use 'ws' if available (Node.js), otherwise fallback to globalThis.WebSocket (Browser)
    const DefaultWebSocketImplementation = typeof WebSocket !== 'undefined'
        ? WebSocket
        : typeof globalThis !== 'undefined'
        ? globalThis.WebSocket
        : undefined;

    if (!DefaultWebSocketImplementation && !opts.WebSocket) {
        throw new Error("WebSocket implementation not found. Please provide one in the options (e.g., import WebSocket from 'ws').");
    }

    const WebSocketImpl = opts.WebSocket || DefaultWebSocketImplementation;

    console.log(`[TypeQL WS Transport] Creating transport for URL: ${opts.url}`);

    // --- Initialize Shared State ---
    // Use 'as any' temporarily for WebSocketImpl if strict checks cause issues,
    // but the logic ensures it's valid.
    const state: ConnectionState = {
        ws: null,
        isConnected: false,
        connectionPromise: null,
        reconnectAttempts: 0,
        reconnectTimeoutId: undefined,
        options: opts, // Store original options
        // Resolve defaults
        WebSocketImplementation: WebSocketImpl as typeof WebSocket | typeof globalThis.WebSocket, // Cast needed after check
        serializer: opts.serializer ?? defaultSerializer,
        deserializer: opts.deserializer ?? defaultDeserializer,
        // State containers
        pendingRequests: new Map<string | number, PendingRequestEntry>(),
        activeSubscriptions: new Map<string | number, ActiveSubscriptionEntry>(),
        connectionChangeListeners: new Set<(connected: boolean) => void>(),
        disconnectListeners: new Set<() => void>(),
        // Pass bound functions for internal use within connection module
        updateConnectionStatus: (newStatus: boolean) => updateConnectionStatus(state, newStatus),
        sendMessage: (payload: any) => sendMessage(state, payload),
        scheduleReconnect: (isImmediate?: boolean) => scheduleReconnect(state, isImmediate),
    };

    // --- Assemble Transport Interface ---
    const transport: TypeQLTransport = {
        // Pass state to handlers
        request: (message: ProcedureCallMessage) => handleRequest(state, message),
        subscribe: (message: SubscribeMessage) => handleSubscribe(state, message),

        // Connection management methods bound to the state
        connect: () => connectWebSocket(state, false), // Explicitly not a reconnect attempt
        disconnect: (code?: number, reason?: string) => disconnectWebSocket(state, code, reason),

        // Connection status getter and listener registration
        get connected() {
            return state.isConnected;
        },
        onConnectionChange: (handler: (connected: boolean) => void) => {
            state.connectionChangeListeners.add(handler);
            return () => state.connectionChangeListeners.delete(handler);
        },
        onDisconnect: (callback: () => void) => {
            state.disconnectListeners.add(callback);
            return () => state.disconnectListeners.delete(callback);
        },

        // Delta request method bound to the state
        requestMissingDeltas: (subscriptionId: number | string, fromSeq: number, toSeq: number) => {
            requestMissingDeltas(state, subscriptionId, fromSeq, toSeq);
        },

        // Expose onAckReceived if provided in options (optional)
        // This is slightly different as it's directly from options, not state management
        onAckReceived: opts.onAckReceived,

    }; // *** End of transport object ***

    // --- Initial Connection Attempt ---
    // Initiate connection eagerly. Use void operator to explicitly ignore the promise result.
    void connectWebSocket(state).catch((error: any) => {
        console.error("[TypeQL WS Transport] Initial connection failed:", error);
        // scheduleReconnect() is called internally by connectWebSocket's error/close handlers
    });

    return transport;
} // *** End of createWebSocketTransport ***

console.log("@typeql/transport-websocket loaded");
