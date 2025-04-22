/**
 * Represents the cleanup function for an active subscription.
 */
type SubscriptionCleanup = Promise<() => void> | (() => void);
/**
 * Manages active subscription cleanup functions globally.
 * Allows adding and removing subscriptions by their unique ID.
 */
export declare class SubscriptionManager {
    private subscriptions;
    /**
     * Registers a new subscription's cleanup function.
     * @param subscriptionId The unique ID of the subscription (from SubscribeMessage).
     * @param cleanupFn The cleanup function returned by the subscription resolver.
     */
    addSubscription(subscriptionId: number | string, cleanupFn: SubscriptionCleanup): void;
    /**
     * Removes a subscription and executes its cleanup function.
     * @param subscriptionId The ID of the subscription to remove.
     */
    removeSubscription(subscriptionId: number | string): void;
    /**
     * Checks if a subscription exists.
     * @param subscriptionId The ID of the subscription.
     * @returns True if the subscription exists, false otherwise.
     */
    hasSubscription(subscriptionId: number | string): boolean;
}
//# sourceMappingURL=subscriptionManager.d.ts.map