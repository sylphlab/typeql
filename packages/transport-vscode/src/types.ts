import type {
    ProcedureResultMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    SubscriptionEndMessage,
    AckMessage,
    RequestMissingMessage, // Import RequestMissingMessage
    UnsubscribeFn,
} from '@sylphlab/typeql-shared';

/**
 * Interface mimicking the relevant parts of the VSCode API object
 * obtained via `acquireVsCodeApi()` in a webview context.
 */
export interface VSCodePostMessage {
    postMessage(message: any): void; // Use 'any' for flexibility with postMessage
    // Define the return type of onDidReceiveMessage more accurately if possible,
    // otherwise keep it general but functional. Assuming it returns a disposable object.
    onDidReceiveMessage(listener: (message: any) => void): { dispose: () => void };
}

/** Union type for messages expected *from* the VSCode extension host. */
export type IncomingMessage =
    | ProcedureResultMessage
    | SubscriptionDataMessage
    | SubscriptionErrorMessage
    | SubscriptionEndMessage
    | AckMessage;
    // Note: RequestMissingMessage is typically sent *to* the host, not received.

/** Options for creating the VSCode transport. */
export interface VSCodeTransportOptions {
    /**
     * The VSCode API object, typically acquired via `acquireVsCodeApi()` in a webview.
     * This object provides `postMessage` and `onDidReceiveMessage`.
     */
    vscodeApi: VSCodePostMessage;
    /** Optional function to generate unique request/subscription IDs. Defaults to a simple counter from @sylphlab/typeql-shared. */
    generateRequestId?: () => string | number;
}

// Re-export shared types that might be useful for consumers alongside transport-specific types
export type {
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    UnsubscribeMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    SubscriptionEndMessage,
    AckMessage,
    RequestMissingMessage,
    UnsubscribeFn,
    TypeQLTransport, // Export the core transport interface
} from '@sylphlab/typeql-shared';

export { TypeQLClientError, generateId } from '@sylphlab/typeql-shared';