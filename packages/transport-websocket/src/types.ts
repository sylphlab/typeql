// packages/transport-websocket/src/types.ts

import type {
    AckMessage,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    SubscriptionDataMessage,
    SubscriptionEndMessage,
    SubscriptionErrorMessage,
    SubscriptionLifecycleMessage,
    UnsubscribeMessage,
    RequestMissingMessage,
    TypeQLTransport, // Keep shared types import if needed elsewhere
    UnsubscribeFn, // Import UnsubscribeFn
} from '@sylphlab/typeql-shared';
import type WebSocket from 'ws'; // Keep for WebSocket type definition

// Re-export shared types if they form part of the public API of this package
export type {
    TypeQLTransport,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    UnsubscribeFn,
    UnsubscribeMessage,
    SubscriptionLifecycleMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    SubscriptionEndMessage,
    AckMessage,
    RequestMissingMessage
} from '@sylphlab/typeql-shared';

/**
 * Options for configuring the WebSocket transport.
 */
export interface WebSocketTransportOptions {
    /** The URL of the WebSocket server. */
    url: string;
    /** Optional custom WebSocket implementation (e.g., browser vs node). Defaults to 'ws' in Node.js or globalThis.WebSocket in browser environments. */
    WebSocket?: typeof WebSocket | typeof globalThis.WebSocket;
    /** Optional custom serializer function. Defaults to JSON.stringify. */
    serializer?: (data: any) => string;
    /** Optional custom deserializer function. Defaults to JSON.parse with handling for different data types. */
    deserializer?: (data: string | Buffer | ArrayBuffer | Buffer[]) => any;
    /** Optional timeout for requests in milliseconds. Defaults to 15000 (15 seconds). */
    requestTimeoutMs?: number;
    /** Optional maximum number of automatic reconnection attempts. Defaults to 5. */
    maxReconnectAttempts?: number;
    /** Optional base delay in milliseconds for exponential backoff during reconnection. Defaults to 1000 (1 second). */
    baseReconnectDelayMs?: number;
    /** Optional callback triggered when an AckMessage is received from the server. */
    onAckReceived?: (ack: AckMessage) => void;
}

/**
 * Minimal WebSocket-like interface for compatibility across environments.
 */
export interface WebSocketLike {
    readonly readyState: number;
    send(data: string | Buffer | ArrayBuffer | Buffer[]): void;
    close(code?: number, reason?: string): void;
    onopen: (() => void) | null;
    onerror: ((event: any) => void) | null; // Use 'any' for broad compatibility
    onclose: ((event: any) => void) | null;
    onmessage: ((event: any) => void) | null;
}

/**
 * Internal structure for managing pending requests (queries/mutations).
 */
export interface PendingRequestEntry {
    resolve: (result: ProcedureResultMessage) => void;
    reject: (reason?: any) => void;
    timer?: ReturnType<typeof setTimeout>;
}

/**
 * Internal structure for managing the state of an active subscription's iterator.
 */
export interface InternalSubscriptionHandlers {
    onData: (message: SubscriptionDataMessage) => void;
    onError: (error: SubscriptionErrorMessage['error']) => void;
    onEnd: () => void;
    onStart?: () => void; // Optional: Called when subscription is confirmed active
}

/**
 * Internal structure for tracking active subscriptions.
 */
export interface ActiveSubscriptionEntry {
    message: SubscribeMessage; // The original subscription request message
    handlers: InternalSubscriptionHandlers; // Handlers managing the iterator state
    active: boolean; // Indicates if currently active (vs. temporarily inactive during reconnect)
}

/**
 * Type for the value yielded by the subscription async iterator.
 */
export type SubscriptionIteratorYield = SubscriptionDataMessage | SubscriptionErrorMessage;

/**
 * The result returned by the `subscribe` method.
 */
export interface SubscriptionResult {
    iterator: AsyncIterableIterator<SubscriptionIteratorYield>;
    unsubscribe: UnsubscribeFn;
}

/**
 * Represents the core state managed by the connection module.
 * This might be passed around or accessed via closures.
 */
export interface ConnectionState {
    ws: WebSocketLike | null;
    isConnected: boolean;
    connectionPromise: Promise<void> | null;
    reconnectAttempts: number;
    reconnectTimeoutId: ReturnType<typeof setTimeout> | undefined;
    readonly options: WebSocketTransportOptions; // Make options accessible
    readonly WebSocketImplementation: typeof WebSocket | typeof globalThis.WebSocket;
    readonly serializer: (data: any) => string;
    readonly deserializer: (data: string | Buffer | ArrayBuffer | Buffer[]) => any;
    readonly pendingRequests: Map<string | number, PendingRequestEntry>;
    readonly activeSubscriptions: Map<string | number, ActiveSubscriptionEntry>;
    readonly connectionChangeListeners: Set<(connected: boolean) => void>;
    readonly disconnectListeners: Set<() => void>;
    updateConnectionStatus: (newStatus: boolean) => void;
    sendMessage: (payload: any) => boolean; // Function to send messages
    scheduleReconnect: (isImmediate?: boolean) => void; // Function to schedule reconnects
}