import type {
    TypeQLTransport,
    ProcedureCallMessage,
    ProcedureResultMessage,
    SubscribeMessage,
    AckMessage, // Import AckMessage
    RequestMissingMessage, // Import RequestMissingMessage
} from '@sylphlab/typeql-shared'; // Use shared package
import { TypeQLClientError } from '@sylphlab/typeql-shared'; // Use shared package

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

// Helper type for pending requests
type PendingRequest = {
    message: ProcedureCallMessage;
    resolve: (value: ProcedureResultMessage) => void;
    reject: (reason?: any) => void;
};

/**
 * Creates a TypeQL transport adapter for HTTP communication using fetch.
 * Primarily supports queries and mutations. Subscriptions are not supported.
 *
 * @param options Configuration options including the server URL.
 * @returns An instance of TypeQLTransport tailored for HTTP.
 */
export function createHttpTransport(options: HttpTransportOptions): TypeQLTransport {
    const { url, fetch: fetchImpl = fetch, batching = false } = options;
    const batchDelayMs = typeof batching === 'object' ? batching.delayMs : (batching ? 10 : 0); // Default 10ms if true

    // --- Variables and Helpers defined INSIDE createHttpTransport scope ---
    let requestQueue: PendingRequest[] = [];
    let batchTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const getHeaders = async (): Promise<HeadersInit> => {
        const baseHeaders: HeadersInit = {
            'Content-Type': 'application/json',
            // Consider adding a specific header for batched requests?
            // 'X-TypeQL-Batch': '1'
        };
        // Removed duplicate 'Content-Type' and closing brace here
        if (!options.headers) {
            return baseHeaders;
        }
        const dynamicHeaders = typeof options.headers === 'function'
            ? await options.headers()
            : options.headers;

        const combined = new Headers(baseHeaders);
        new Headers(dynamicHeaders).forEach((value, key) => {
            combined.set(key, value);
        });
        return combined;
    };

    // Helper function for sending single requests (defined BEFORE transport object)
    const sendSingleRequest = async (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
         console.debug(`[HTTP Transport] Sending single ${message.type} request to ${url} for path: ${message.path}`);
         let response: Response;
         try {
             const headers = await getHeaders();
             response = await fetchImpl(url, {
                 method: 'POST',
                 headers: headers,
                 body: JSON.stringify(message), // Send single message object
             });
         } catch (error: any) {
             console.error(`[HTTP Transport] Fetch failed for single request ${message.id}:`, error);
             throw new TypeQLClientError(`Network request failed: ${error.message || error}`);
         }

         if (!response.ok) {
             console.error(`[HTTP Transport] Single request failed with status ${response.status} for ID ${message.id}`);
             let errorBody = `HTTP error ${response.status}`;
             try { errorBody = await response.text(); } catch { /* Ignore */ }
             throw new TypeQLClientError(`Request failed: ${response.statusText} (${response.status}) - ${errorBody}`, String(response.status));
         }

         try {
             const resultJson = await response.json();
             if (typeof resultJson !== 'object' || resultJson === null || !('id' in resultJson) || !('result' in resultJson)) {
                 throw new TypeQLClientError('Invalid response format received from server.');
             }
             console.debug(`[HTTP Transport] Received single response for ID ${resultJson.id}`);
             return resultJson as ProcedureResultMessage;
         } catch (error: any) {
             console.error(`[HTTP Transport] Failed to parse JSON response for single request ${message.id}:`, error);
             throw new TypeQLClientError(`Failed to parse response: ${error.message || error}`);
         }
    };


    // Batch Processing Logic (defined BEFORE transport object)
    const processBatch = async () => {
        if (batchTimeoutId) {
            clearTimeout(batchTimeoutId);
            batchTimeoutId = null;
        }
        if (requestQueue.length === 0) {
            return;
        }

        const batch = [...requestQueue];
        requestQueue = []; // Clear queue immediately

        const messagesToSend = batch.map(req => req.message);
        const batchId = messagesToSend.map(m => m.id).join(','); // For logging
        console.debug(`[HTTP Transport] Processing batch (${batch.length} requests) to ${url}. IDs: ${batchId}`);

        let response: Response;
        try {
            const headers = await getHeaders();
            // Server MUST be adapted to handle an array of messages
            response = await fetchImpl(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(messagesToSend),
            });
        } catch (error: any) {
            console.error(`[HTTP Transport] Fetch failed for batch ${batchId}:`, error);
            const err = new TypeQLClientError(`Network request failed for batch: ${error.message || error}`);
            batch.forEach(req => req.reject(err));
            return;
        }

        if (!response.ok) {
            console.error(`[HTTP Transport] Batch request failed with status ${response.status}. IDs: ${batchId}`);
            let errorBody = `HTTP error ${response.status}`;
            try { errorBody = await response.text(); } catch { /* Ignore */ }
            const err = new TypeQLClientError(`Batch request failed: ${response.statusText} (${response.status}) - ${errorBody}`, String(response.status));
            batch.forEach(req => req.reject(err));
            return;
        }

        try {
            const results = await response.json();
            // Server MUST return an array of results in the same order
            if (!Array.isArray(results)) {
                throw new TypeQLClientError('Invalid batch response format: expected an array.');
            }
            if (results.length !== batch.length) {
                 throw new TypeQLClientError(`Mismatched batch response length: expected ${batch.length}, got ${results.length}`);
            }

            console.debug(`[HTTP Transport] Received batch response for ${results.length} requests.`);

            results.forEach((result: any, index: number) => {
                const originalRequest = batch[index];
                if (!originalRequest) {
                    console.error(`[HTTP Transport] Batch response index ${index} out of bounds.`);
                    return;
                }
                if (typeof result !== 'object' || result === null || !('id' in result) || !('result' in result)) {
                    console.error(`[HTTP Transport] Invalid result format in batch response at index ${index} for ID ${originalRequest.message.id}:`, result);
                    originalRequest.reject(new TypeQLClientError(`Invalid result format in batch response for ID ${originalRequest.message.id}.`));
                    return;
                }
                if (result.id !== originalRequest.message.id) {
                     console.warn(`[HTTP Transport] Batch response ID mismatch at index ${index}: expected ${originalRequest.message.id}, got ${result.id}. Resolving based on index.`);
                }
                originalRequest.resolve(result as ProcedureResultMessage);
            });

        } catch (error: any) {
            console.error(`[HTTP Transport] Failed to process batch response for IDs ${batchId}:`, error);
            const err = new TypeQLClientError(`Failed to process batch response: ${error.message || error}`);
            batch.forEach(req => req.reject(err));
        }
    };
    // --- End Batch Processing Logic ---

    // --- Transport Object Definition ---
    const transport: TypeQLTransport = {
        request: (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
            if (!batching || batchDelayMs <= 0) {
                 if (requestQueue.length > 0) {
                    processBatch(); // Process existing queue synchronously first
                 }
                 return sendSingleRequest(message); // Send current one individually
            }

            // Batching enabled with delay
            return new Promise((resolve, reject) => {
                requestQueue.push({ message, resolve, reject });
                if (batchTimeoutId) {
                    clearTimeout(batchTimeoutId);
                }
                batchTimeoutId = setTimeout(processBatch, batchDelayMs);
            });
        },

        // sendSingleRequest is NOT part of the transport object itself

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
    };

    return transport;
} // Removed extra closing brace here

console.log("@typeql/transport-http loaded");