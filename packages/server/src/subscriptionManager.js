// Removed unused imports
// import type { TypeQLTransport, SubscriptionDataMessage, SubscribeMessage } from '../core/types';
// import type { SubscriptionResolver } from './procedure'; // Corrected import path/presence
/**
 * Manages active subscription cleanup functions globally.
 * Allows adding and removing subscriptions by their unique ID.
 */
export class SubscriptionManager {
    // Map where keys are subscription IDs (from SubscribeMessage) and values are cleanup functions.
    subscriptions = new Map();
    /**
     * Registers a new subscription's cleanup function.
     * @param subscriptionId The unique ID of the subscription (from SubscribeMessage).
     * @param cleanupFn The cleanup function returned by the subscription resolver.
     */
    addSubscription(subscriptionId, cleanupFn) {
        if (this.subscriptions.has(subscriptionId)) {
            console.warn(`[TypeQL SubManager] Subscription cleanup with ID ${subscriptionId} already exists. Overwriting.`);
            // Ensure old cleanup is called before overwriting
            this.removeSubscription(subscriptionId);
        }
        this.subscriptions.set(subscriptionId, cleanupFn);
        console.log(`[TypeQL SubManager] Added cleanup for subscription ${subscriptionId}`);
    }
    /**
     * Removes a subscription and executes its cleanup function.
     * @param subscriptionId The ID of the subscription to remove.
     */
    removeSubscription(subscriptionId) {
        const cleanupTask = this.subscriptions.get(subscriptionId);
        if (cleanupTask) {
            this.subscriptions.delete(subscriptionId);
            console.log(`[TypeQL SubManager] Removed subscription ${subscriptionId}. Executing cleanup.`);
            // Execute cleanup, handling potential promise
            try {
                // Check if it's a function before calling directly
                if (typeof cleanupTask === 'function') {
                    cleanupTask(); // Call synchronous cleanup
                }
                else if (cleanupTask instanceof Promise) {
                    // If it's a promise, await it, then call the resolved function
                    cleanupTask.then(finalCleanupFn => {
                        if (typeof finalCleanupFn === 'function') {
                            finalCleanupFn();
                        }
                    }).catch(err => {
                        console.error(`[TypeQL SubManager] Async cleanup promise error for subscription ${subscriptionId}:`, err);
                    });
                }
            }
            catch (err) {
                // Catch synchronous errors from calling cleanupFn itself
                console.error(`[TypeQL SubManager] Error during cleanup execution for subscription ${subscriptionId}:`, err);
            }
        }
        else {
            console.warn(`[TypeQL SubManager] Attempted to remove non-existent subscription ID: ${subscriptionId}`);
        }
    }
    /**
     * Checks if a subscription exists.
     * @param subscriptionId The ID of the subscription.
     * @returns True if the subscription exists, false otherwise.
     */
    hasSubscription(subscriptionId) {
        return this.subscriptions.has(subscriptionId);
    }
}
//# sourceMappingURL=subscriptionManager.js.map