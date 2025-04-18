// packages/transport-websocket/src/request.ts

import type {
    ConnectionState,
    PendingRequestEntry,
    ProcedureCallMessage,
    ProcedureResultMessage,
} from './types';
import { connectWebSocket, sendMessage } from './connection';
import { OPEN, DEFAULT_REQUEST_TIMEOUT_MS } from './constants';

/**
 * Handles sending a procedure call request and managing the promise for its result.
 * Includes connection checks and request timeouts.
 * @param state - The shared connection state.
 * @param message - The procedure call message to send.
 * @returns A promise that resolves with the ProcedureResultMessage or rejects on error/timeout.
 */
export async function handleRequest(
    state: ConnectionState,
    message: ProcedureCallMessage
): Promise<ProcedureResultMessage> {
    // Ensure connection exists or is being established
    // Use the connectWebSocket function from the connection module
    await (state.connectionPromise || connectWebSocket(state));

    // If still not connected after attempt, throw
    if (!state.ws || state.ws.readyState !== OPEN) {
        throw new Error("WebSocket not connected for request.");
    }

    const requestTimeout = state.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        // Create the entry for pending requests, including the reject wrapper for timer cleanup
        const reqEntry: PendingRequestEntry = {
            resolve,
            reject: (reason?: any) => {
                if (timer) clearTimeout(timer); // Clear timer on rejection
                state.pendingRequests.delete(message.id); // Ensure cleanup from map on rejection
                reject(reason);
            },
            timer: undefined, // Initialize timer property
        };

        if (requestTimeout > 0) {
            // Assign the timer to the captured variable `timer` as well
            timer = setTimeout(() => {
                // Use the wrapped reject function to ensure cleanup
                reqEntry.reject(new Error(`Request timed out after ${requestTimeout}ms (ID: ${message.id})`));
            }, requestTimeout);
            reqEntry.timer = timer; // Also store it in the entry
        }

        state.pendingRequests.set(message.id, reqEntry);

        // Use the sendMessage function from the connection module
        if (!sendMessage(state, message)) {
            // If send fails immediately, reject the promise using the wrapped reject
            reqEntry.reject(new Error(`Failed to send request message immediately (ID: ${message.id})`));
            // No need to delete from map here, reqEntry.reject handles it
        }
        // If sendMessage succeeded, the promise will be resolved/rejected by handleMessage or the timeout
    });
}