import type {
    ProcedureCallMessage,
    ProcedureResultMessage,
} from '@sylphlab/typeql-shared';

export interface HttpTransportOptions {
    /** The URL of the TypeQL HTTP endpoint. */
    url: string;
    /** Optional custom fetch implementation. Defaults to global fetch. */
    fetch?: typeof fetch;
    /** Optional headers to include in requests. */
    headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
    /**
     * Enable request batching.
     * - `false` (default): Send requests immediately.
     * - `true`: Batch requests using a default delay (e.g., 10ms).
     * - `{ delayMs: number }`: Batch requests with a specific debounce delay.
     */
    batching?: boolean | { delayMs: number };
}

// Helper type for pending requests in batching
export type PendingRequest = {
    message: ProcedureCallMessage;
    resolve: (value: ProcedureResultMessage) => void;
    reject: (reason?: any) => void;
};