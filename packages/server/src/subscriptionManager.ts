// Removed unused imports
// import type { zenQueryTransport, SubscriptionDataMessage, SubscribeMessage } from '../core/types';
// import type { SubscriptionResolver } from './procedure'; // Corrected import path/presence

/**
 * Represents the cleanup function for an active subscription.
 */
type SubscriptionCleanup = Promise<() => void> | (() => void);

/**
 * Manages active subscription cleanup functions globally.
 * Allows adding and removing subscriptions by their unique ID.
 */
export class SubscriptionManager {
  // Map where keys are subscription IDs (from SubscribeMessage) and values are cleanup functions.
  private subscriptions: Map<number | string, SubscriptionCleanup> = new Map();

  /**
   * Registers a new subscription's cleanup function.
   * @param subscriptionId The unique ID of the subscription (from SubscribeMessage).
   * @param cleanupFn The cleanup function returned by the subscription resolver.
   */
  addSubscription(
      subscriptionId: number | string,
      cleanupFn: SubscriptionCleanup
  ): void {
    if (this.subscriptions.has(subscriptionId)) {
      console.warn(`[zenQuery SubManager] Subscription cleanup with ID ${subscriptionId} already exists. Overwriting.`);
       // Ensure old cleanup is called before overwriting
        // Use Promise.resolve to handle potential async removeSubscription if needed in future
        Promise.resolve(this.removeSubscription(subscriptionId)).catch(err => {
             console.error(`[zenQuery SubManager] Error during implicit removeSubscription in addSubscription for ID ${subscriptionId}:`, err);
        });
    }
    this.subscriptions.set(subscriptionId, cleanupFn);
    console.log(`[zenQuery SubManager] Added cleanup for subscription ${subscriptionId}`);
  }

  /**
   * Removes a subscription and executes its cleanup function.
   * @param subscriptionId The ID of the subscription to remove.
   */
  async removeSubscription(subscriptionId: number | string): Promise<void> { // Keep async
    const cleanupTask = this.subscriptions.get(subscriptionId);
    if (cleanupTask) {
      this.subscriptions.delete(subscriptionId);
      console.log(`[zenQuery SubManager] Removed subscription ${subscriptionId}. Executing cleanup.`);

      try {
        if (typeof cleanupTask === 'function') {
          // Execute synchronous cleanup directly within the main try block
          cleanupTask();
        } else if (cleanupTask instanceof Promise) {
          // Await the promise first
          const finalCleanupFn = await cleanupTask;
          // If the promise resolved to a function, execute it in a nested try...catch
          if (typeof finalCleanupFn === 'function') {
            try {
              finalCleanupFn(); // Call the resolved cleanup function
            } catch (execErr) {
              // Catch errors specifically from the resolved function's execution
              // Log with the message expected by the test for execution errors
              console.error(`[zenQuery SubManager] Error during cleanup execution for subscription ${subscriptionId}:`, execErr);
            }
          }
        }
      } catch (err) {
        // This outer catch block handles errors from sync execution
        // or the promise rejection itself (await cleanupTask).
        // Log rejection with the specific message expected by the rejection test.
        console.error(`[zenQuery SubManager] Async cleanup promise rejected for subscription ${subscriptionId}:`, err);
      }
    } else {
      console.warn(`[zenQuery SubManager] Attempted to remove non-existent subscription ID: ${subscriptionId}`);
    }
  }

  /**
   * Checks if a subscription exists.
   * @param subscriptionId The ID of the subscription.
   * @returns True if the subscription exists, false otherwise.
   */
  hasSubscription(subscriptionId: number | string): boolean {
    return this.subscriptions.has(subscriptionId);
  }

  // Removed removeClientSubscriptions - Client-specific cleanup should be handled by RequestHandler
  // Removed getTransportForSubscription - Transport is managed by RequestHandler
}
