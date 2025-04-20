/// <reference types="vscode-webview" />

import type {
    AckMessage,
    ProcedureCallMessage,
    ProcedureResultMessage,
    RequestMissingMessage,
    SubscribeMessage,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    TypeQLTransport,
    UnsubscribeFn,
    // UnsubscribeMessage is only used in helpers now
} from '@sylphlab/typeql-shared';
import type { PendingRequest, ActiveSubscription } from './types';
import { createMessageHandler } from './messageHandler';
import { handleSubscribe } from './subscriptionHandler';
import { ConnectionManager } from './connectionHandler';
import { handleRequest, handleRequestMissingDeltas } from './requestHandler';
// Helpers are imported and used within the specific handlers now

/**
 * A TypeQL transport layer implementation for communication between a VS Code webview
 * and the extension host.
 */
export class VSCodeTransport implements TypeQLTransport {
    // Public properties required by handlers/helpers
    public readonly pendingRequests = new Map<number | string, PendingRequest>();
    public readonly activeSubscriptions = new Map<number | string, ActiveSubscription>();
    public onAckReceived?: (ack: AckMessage) => void;
    public readonly vscodeApi: any; // Keep as any for now
    public nextId = 1; // Public for generateIdHelper access

    // Private state
    private readonly eventTarget: {
        addEventListener: (type: string, listener: any) => void;
        removeEventListener: (type: string, listener: any) => void;
    };
    private messageListenerAttached = false;
    private readonly connectionManager: ConnectionManager; // Instance of ConnectionManager

    // Inject dependencies: vscodeApi and the target for event listening (window)
    constructor(
        vscodeApiInstance?: any, // Allow passing mock API
        target: {
            addEventListener: (type: string, listener: any) => void;
            removeEventListener: (type: string, listener: any) => void;
        } = window // Default to global window
    ) {
        // Use provided instance or acquire global one
        this.vscodeApi = vscodeApiInstance ?? acquireVsCodeApi();
        this.eventTarget = target;

        // Instantiate ConnectionManager, passing callbacks bound to 'this'
        this.connectionManager = new ConnectionManager(
            this.attachMessageListener.bind(this),
            this.performCleanup.bind(this) // Pass bound cleanup method
        );

        this.attachMessageListener();
    }

    // --- Core Methods (Delegated) ---

    request(message: ProcedureCallMessage): Promise<ProcedureResultMessage> {
        // Delegate request handling
        return handleRequest(this, message);
    }

    subscribe(message: SubscribeMessage): {
        iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>;
        unsubscribe: UnsubscribeFn;
    } {
        // Delegate subscription handling
        return handleSubscribe(this, message);
    }

    // --- Optional Methods & Properties (Delegated) ---

    get connected(): boolean {
        return this.connectionManager.isConnected;
    }

    onConnectionChange(handler: (connected: boolean) => void): () => void {
        return this.connectionManager.onConnectionChange(handler);
    }

    onDisconnect(callback: () => void): () => void {
        return this.connectionManager.onDisconnect(callback);
    }

    connect(): void {
        this.connectionManager.connect();
    }

    disconnect(code?: number, reason?: string): void {
        // Delegate to connection manager (ignore code for now)
        this.connectionManager.disconnect(reason);
    }

    // Send the request missing message (Delegated)
    requestMissingDeltas(subscriptionId: string | number, fromSeq: number, toSeq: number): void | Promise<void> {
        // Delegate to request handler
        handleRequestMissingDeltas(this, subscriptionId, fromSeq, toSeq);
    }


    // --- Private Methods ---

    private attachMessageListener(): void {
        if (this.messageListenerAttached) return;
        this.eventTarget.addEventListener(
            'message',
            createMessageHandler(
                this.pendingRequests,
                this.activeSubscriptions,
                () => this.onAckReceived,
                this.cleanupSubscription // Pass the bound arrow function
            )
        );
        this.messageListenerAttached = true;
    }

    // Internal cleanup logic called by ConnectionManager on disconnect
    // Needs to be public for ConnectionManager callback
    public performCleanup(reason?: string): void {
        this.pendingRequests.forEach(p => p.reject(new Error(reason ?? 'Transport disconnected')));
        this.pendingRequests.clear();
        this.activeSubscriptions.forEach((sub, id) => {
            sub.isComplete = true;
            sub.rejectIterator?.(new Error(reason ?? 'Transport disconnected'));
            this.cleanupSubscription(id, false); // Call public cleanup
        });
    }

    // Public for handler access, use arrow function for binding
    // Logic moved to helpers.ts, keep signature for context passing if needed by handlers.
    public cleanupSubscription = (id: number | string, notifyComplete = true): void => {
        // Actual logic is now in cleanupSubscriptionHelper (called by messageHandler/subscriptionHandler)
        // This method body can be removed if handlers exclusively use the helper.
        // Keeping it empty for now to satisfy potential interface requirements if handlers expect it.
        // Re-evaluate if direct calls are needed vs helper calls.
        // For now, assume handlers call the helper.
        const subscription = this.activeSubscriptions.get(id);
         if (subscription) {
            if (notifyComplete) {
                 subscription.isComplete = true;
                 if (subscription.resolveNext) {
                     subscription.resolveNext({ done: true, value: undefined });
                 }
            }
            subscription.rejectIterator?.(new Error('Subscription unsubscribed or ended.'));
            this.activeSubscriptions.delete(id);
        }
        // Note: If keeping this method, it should ideally call the helper:
        // import { cleanupSubscriptionHelper } from './helpers';
        // cleanupSubscriptionHelper(this, id, notifyComplete);
    }

    // generateId and unsubscribe logic fully moved to helpers and called by handlers.
    // No need for the methods here anymore.
}

// Optional: Export a singleton instance if appropriate for webview usage
// export const vscodeTransport = new VSCodeTransport();
