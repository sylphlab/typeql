import type {
    TypeQLTransport,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    AckMessage,
    RequestMissingMessage, // Keep shared imports
} from '@sylphlab/typeql-shared';
import { TypeQLClientError } from '@sylphlab/typeql-shared';

// Import from new modules
import type { HttpTransportOptions } from './types';
import { createHeaderGetter } from './headers';
import { sendSingleRequest } from './singleRequest';
import { createBatchProcessor, type BatchProcessor } from './batchRequest';

/**
 * Creates a TypeQL transport adapter for HTTP communication using fetch.
 * Primarily supports queries and mutations. Subscriptions are not supported.
 * Handles optional request batching.
 *
 * @param options Configuration options including the server URL, fetch implementation, headers, and batching settings.
 * @returns An instance of TypeQLTransport tailored for HTTP.
 */
export function createHttpTransport(options: HttpTransportOptions): TypeQLTransport {
    const { url, fetch: fetchImpl = fetch, batching = false } = options;
    const batchDelayMs = typeof batching === 'object' ? batching.delayMs : (batching ? 10 : 0); // Default 10ms if true
    const isBatchingEnabled = batching && batchDelayMs > 0;

    // Instantiate helpers from modules
    const getHeaders = createHeaderGetter(options);
    let batchProcessor: BatchProcessor | null = null;

    if (isBatchingEnabled) {
        batchProcessor = createBatchProcessor(url, fetchImpl, getHeaders, batchDelayMs);
    }

    const transport: TypeQLTransport = {
        request: (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
            if (!isBatchingEnabled || !batchProcessor) {
                 // If batching was enabled but somehow processor is null, fallback to single
                 if (batchProcessor?.hasPending()) {
                    // Process any previously queued items if switching off batching dynamically (though not typical)
                    batchProcessor.flushQueue();
                 }
                 return sendSingleRequest(message, url, fetchImpl, getHeaders); // Send current one individually
            }

            // Batching enabled
            return batchProcessor.queueRequest(message);
        },

        subscribe: (message: SubscribeMessage) => {
            console.error("[HTTP Transport] Subscriptions are not supported over standard HTTP transport.");
            throw new TypeQLClientError("Subscriptions require a persistent connection (e.g., WebSockets). HTTP transport does not support them.");
        },

        onAckReceived: (ack: AckMessage) => {
             console.warn("[HTTP Transport] Received Ack message, but HTTP transport doesn't typically handle these:", ack);
        },

        requestMissingDeltas: (subscriptionId: number | string, fromSeq: number, toSeq: number) => {
             console.error("[HTTP Transport] Cannot request missing deltas over HTTP transport.");
        },

        // Optional connect/disconnect are no-ops for stateless HTTP
        // connect: () => { /* No-op */ },
        // disconnect: () => { /* No-op */ },
    };

    return transport;
}

// Re-export relevant types
export type { HttpTransportOptions };

// console.log("@typeql/transport-http loaded"); // Removed original log