/**
 * Entry point for the @typeql/transport-vscode package.
 * Re-exports the core functionality and types for VSCode webview communication.
 */

// Re-export the main transport creation function
export { createVSCodeTransport } from './transport';

// Re-export necessary types for consumers
export type {
    VSCodeTransportOptions,
    VSCodePostMessage, // Might be useful for consumers mocking the API
    // Re-export core shared types as well for convenience
    TypeQLTransport,
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
} from './types';

// Re-export error class and ID generator
export { TypeQLClientError, generateId } from './types';

console.log("@typeql/transport-vscode entry point loaded");