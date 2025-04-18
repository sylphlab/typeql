import type {
    ProcedureCallMessage,
    ProcedureResultMessage,
} from '@sylphlab/typeql-shared';
import { TypeQLClientError } from '@sylphlab/typeql-shared';

/**
 * Sends a single TypeQL procedure call message via HTTP POST.
 *
 * @param message - The procedure call message to send.
 * @param url - The target URL for the HTTP request.
 * @param fetchImpl - The fetch implementation to use.
 * @param getHeaders - An async function to retrieve request headers.
 * @returns A promise that resolves with the procedure result message or rejects on error.
 */
export async function sendSingleRequest(
    message: ProcedureCallMessage,
    url: string,
    fetchImpl: typeof fetch,
    getHeaders: () => Promise<HeadersInit>
): Promise<ProcedureResultMessage> {
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
        // Basic validation of the response structure
        if (typeof resultJson !== 'object' || resultJson === null || !('id' in resultJson) || !('result' in resultJson)) {
            throw new TypeQLClientError('Invalid response format received from server.');
        }
        console.debug(`[HTTP Transport] Received single response for ID ${resultJson.id}`);
        return resultJson as ProcedureResultMessage;
    } catch (error: any) {
        console.error(`[HTTP Transport] Failed to parse JSON response for single request ${message.id}:`, error);
        throw new TypeQLClientError(`Failed to parse response: ${error.message || error}`);
    }
}