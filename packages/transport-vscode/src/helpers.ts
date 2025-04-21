import type { UnsubscribeFn, UnsubscribeMessage } from '@sylphlab/zen-query-shared';
import type { ActiveSubscription } from './types';

// Minimal interface for the transport context needed by helpers
interface HelperTransportContext {
    nextId: number; // Assuming nextId is managed within the main class still, maybe make public? Or pass getter/setter? Let's assume public for now.
    activeSubscriptions: Map<number | string, ActiveSubscription>;
    vscodeApi: { postMessage: (message: any) => void };
    // Need cleanupSubscription itself to be callable within unsubscribe
    cleanupSubscription: (id: number | string, notifyComplete?: boolean) => void;
}

/**
 * Generates the next unique ID.
 * Note: This modifies the transport's internal state.
 */
export function generateIdHelper(transport: { nextId: number }): number {
    // This directly mutates the transport's property. Consider if this is desired.
    // An alternative is the transport calling this and updating its own state.
    return transport.nextId++;
}

/**
 * Creates the unsubscribe function for a specific subscription ID.
 */
export function createUnsubscribeFn(
    transport: HelperTransportContext,
    id: number | string
): UnsubscribeFn {
    return () => {
        if (transport.activeSubscriptions.has(id)) {
            const message: UnsubscribeMessage = { id, type: 'subscriptionStop' };
            try {
                transport.vscodeApi.postMessage(message);
            } catch (error) {
                console.error(`Failed to send unsubscribe for ${id}:`, error);
                // Still attempt local cleanup even if postMessage fails
            } finally {
                // Call the cleanup function passed in the context
                transport.cleanupSubscription(id, false); // Clean up locally immediately
            }
        }
    };
}

/**
 * Cleans up subscription state.
 */
export function cleanupSubscriptionHelper(
    transport: { activeSubscriptions: Map<number | string, ActiveSubscription> },
    id: number | string,
    notifyComplete = true
): void {
    const subscription = transport.activeSubscriptions.get(id);
    if (subscription) {
        if (notifyComplete) {
             subscription.isComplete = true;
             if (subscription.resolveNext) {
                 subscription.resolveNext({ done: true, value: undefined });
             }
        }
        // Always reject any pending iterator promise if it exists during cleanup.
        subscription.rejectIterator?.(new Error('Subscription unsubscribed or ended.'));
        transport.activeSubscriptions.delete(id);
    }
}