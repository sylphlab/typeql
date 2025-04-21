import type { ProcedureCallMessage, ProcedureResultMessage, RequestMissingMessage } from '@sylphlab/zen-query-shared';
import type { PendingRequest } from './types';
import { generateIdHelper } from './helpers'; // Import helper

// Minimal interface for the transport context needed by the request handlers
interface RequestHandlerTransportContext {
    pendingRequests: Map<number | string, PendingRequest>;
    vscodeApi: { postMessage: (message: any) => void }; // Simplified API type
    nextId: number; // Still need nextId state for the helper
}

/**
 * Handles sending a request message and managing the pending promise.
 *
 * @param transport The transport context containing necessary state and methods.
 * @param message The procedure call message.
 * @returns A promise resolving with the procedure result message.
 */
export function handleRequest(
    transport: RequestHandlerTransportContext,
    message: ProcedureCallMessage
): Promise<ProcedureResultMessage> {
    // Use helper to generate ID
    const id = message.id ?? generateIdHelper(transport);
    const msgWithId = { ...message, id };

    return new Promise((resolve, reject) => {
        transport.pendingRequests.set(id, { resolve, reject });
        try {
            transport.vscodeApi.postMessage(msgWithId);
            // TODO: Add timeout for requests?
        } catch (error) {
            transport.pendingRequests.delete(id);
            reject(error);
        }
    });
}

/**
 * Handles sending a request_missing message.
 *
 * @param transport The transport context containing necessary state and methods.
 * @param subscriptionId The ID of the subscription requiring recovery.
 * @param fromSeq The server sequence number *after* the last confirmed one.
 * @param toSeq The server sequence number of the delta that triggered the gap detection.
 */
export function handleRequestMissingDeltas(
    transport: RequestHandlerTransportContext,
    subscriptionId: string | number,
    fromSeq: number,
    toSeq: number
): void {
    const message: RequestMissingMessage = {
        id: subscriptionId,
        type: 'request_missing',
        fromSeq,
        toSeq,
    };
    try {
        transport.vscodeApi.postMessage(message);
    } catch (error) {
        console.error('Failed to send request_missing message:', error);
        // Decide if this should throw or just log
    }
}