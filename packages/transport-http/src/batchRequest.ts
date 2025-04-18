import type {
    ProcedureCallMessage,
    ProcedureResultMessage,
} from '@sylphlab/typeql-shared';
import { TypeQLClientError } from '@sylphlab/typeql-shared';
import type { PendingRequest } from './types';

/**
 * Manages the batching of procedure call requests.
 *
 * @param url - The target URL for the HTTP request.
 * @param fetchImpl - The fetch implementation to use.
 * @param getHeaders - An async function to retrieve request headers.
 * @param batchDelayMs - The debounce delay for batching in milliseconds.
 * @returns An object with methods to queue requests and process the batch.
 */
export function createBatchProcessor(
    url: string,
    fetchImpl: typeof fetch,
    getHeaders: () => Promise<HeadersInit>,
    batchDelayMs: number
) {
    let requestQueue: PendingRequest[] = [];
    let batchTimeoutId: ReturnType<typeof setTimeout> | null = null;

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
                     return; // Skip this result if no matching request
                 }
                 try {
                     if (typeof result !== 'object' || result === null || !('id' in result) || !('result' in result)) {
                         // Structure is invalid, reject this specific promise and stop processing it
                         const individualError = new TypeQLClientError(`Invalid result format in batch response for ID ${originalRequest.message.id}.`);
                         console.error(`[HTTP Transport] Error processing individual batch result for ID ${originalRequest.message.id}:`, individualError);
                         originalRequest.reject(individualError);
                         return; // Stop processing this item
                     }
                     if (result.id !== originalRequest.message.id) {
                         console.warn(`[HTTP Transport] Batch response ID mismatch at index ${index}: expected ${originalRequest.message.id}, got ${result.id}. Resolving based on index.`);
                     }
                     // Structure is valid, resolve the promise
                     originalRequest.resolve(result as ProcedureResultMessage);
                 } catch (individualError: any) { // This catch might now be redundant but kept for safety
                     // Should ideally not be reached if the above logic is correct
                     console.error(`[HTTP Transport] Unexpected error processing individual batch result for ID ${originalRequest.message.id}:`, individualError);
                     originalRequest.reject(individualError instanceof TypeQLClientError ? individualError : new TypeQLClientError(`Failed processing result: ${individualError.message || individualError}`));
                 }
             });

        } catch (error: any) { // This outer catch now only handles fetch.json(), array check, length check errors
            console.error(`[HTTP Transport] Failed to process overall batch response for IDs ${batchId}:`, error);
            const err = new TypeQLClientError(`Failed to process batch response: ${error.message || error}`);
            // Reject all promises in the batch if overall processing fails (e.g., invalid JSON array)
            batch.forEach(req => {
                // Avoid double-rejecting if already rejected by inner catch
                // (This requires a more complex state tracking or assumes reject is idempotent)
                // For simplicity, we might just call reject again, letting the promise handle it.
                req.reject(err);
            });
        }
    };

    const queueRequest = (message: ProcedureCallMessage): Promise<ProcedureResultMessage> => {
        return new Promise((resolve, reject) => {
            requestQueue.push({ message, resolve, reject });
            if (batchTimeoutId) {
                clearTimeout(batchTimeoutId);
            }
            batchTimeoutId = setTimeout(processBatch, batchDelayMs);
        });
    };

    const flushQueue = (): void => {
        // Immediately process any pending requests
        if (requestQueue.length > 0) {
            processBatch();
        }
    };

    const hasPending = (): boolean => {
        return requestQueue.length > 0;
    }

    return {
        queueRequest,
        flushQueue,
        hasPending,
    };
}

export type BatchProcessor = ReturnType<typeof createBatchProcessor>;