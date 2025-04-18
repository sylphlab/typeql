import type { ProcedureResultMessage } from './types';
import { TypeQLClientError } from './types'; // Import error type

// Structure for storing pending request callbacks
interface PendingRequest {
    resolve: (result: ProcedureResultMessage) => void;
    reject: (reason?: any) => void;
}

// Interface for the request manager
export interface RequestManager {
    add(id: string | number, resolve: (result: ProcedureResultMessage) => void, reject: (reason?: any) => void): void;
    resolveRequest(id: string | number, message: ProcedureResultMessage): void;
    rejectRequest(id: string | number, error: Error): void;
    rejectAll(error: Error): void;
    hasRequest(id: string | number): boolean;
    deleteRequest(id: string | number): boolean; // Returns true if deleted
}

/**
 * Creates a manager for pending procedure requests.
 * Encapsulates the state and logic for handling request lifecycles.
 *
 * @returns An instance of RequestManager.
 */
export function createRequestManager(): RequestManager {
    const pendingRequests = new Map<string | number, PendingRequest>();

    return {
        /** Adds a new pending request. */
        add(id, resolve, reject) {
            if (pendingRequests.has(id)) {
                // This shouldn't happen if IDs are unique, but good to guard
                console.warn(`[RequestManager] Request with ID ${id} already exists. Overwriting.`);
                // Potentially reject the old one first?
                // pendingRequests.get(id)?.reject(new TypeQLClientError('Request superseded'));
            }
            pendingRequests.set(id, { resolve, reject });
        },

        /** Resolves a pending request and removes it from the map. */
        resolveRequest(id, message) {
            const pending = pendingRequests.get(id);
            if (pending) {
                pending.resolve(message);
                pendingRequests.delete(id);
            } else {
                // This case is handled by the message handler, but log defensively
                console.warn(`[RequestManager] Attempted to resolve non-existent request ID: ${id}`);
            }
        },

        /** Rejects a pending request and removes it from the map. */
        rejectRequest(id, error) {
            const pending = pendingRequests.get(id);
            if (pending) {
                pending.reject(error);
                pendingRequests.delete(id);
            } else {
                console.warn(`[RequestManager] Attempted to reject non-existent request ID: ${id}`);
            }
        },

        /** Rejects all pending requests, typically during transport disconnection. */
        rejectAll(error) {
            console.warn(`[RequestManager] Rejecting all (${pendingRequests.size}) pending requests due to: ${error.message}`);
            pendingRequests.forEach((pending, id) => {
                pending.reject(error);
            });
            pendingRequests.clear();
        },

        /** Checks if a request with the given ID is currently pending. */
        hasRequest(id) {
            return pendingRequests.has(id);
        },

        /** Deletes a request from the map, e.g., if sending failed. Returns true if deleted. */
        deleteRequest(id) {
            return pendingRequests.delete(id);
        }
    };
}