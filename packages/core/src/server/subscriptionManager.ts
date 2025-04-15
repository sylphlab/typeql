import type { TypeQLTransport, SubscriptionDataMessage, SubscribeMessage } from '../core/types';
import type { SubscriptionResolver } from './procedure'; // Corrected import path/presence

/**
 * Represents an active subscription.
 */
interface ActiveSubscription {
  clientId: string; // Identifier for the client connection (might be connection-specific ID)
  subscriptionId: number | string; // ID from the original SubscribeMessage
  transport: TypeQLTransport; // The specific transport instance for this client connection
  // Type cleanupFn explicitly based on SubscriptionResolver definition
  cleanupFn: Promise<() => void> | (() => void);
}

/**
 * Manages client subscriptions based on TypeQL's SubscribeMessage ID.
 * Allows adding, removing subscriptions, and retrieving subscribers.
 * NOTE: This manager might need significant refactoring to align with TypeQL's path-based procedures
 * rather than simple topics. This needs further refinement based on transport layer specifics.
 */
export class SubscriptionManager {
  // Map where keys are subscription IDs (from SubscribeMessage) and values are ActiveSubscription objects.
  private subscriptions: Map<number | string, ActiveSubscription> = new Map();
  // TODO: Need a way to associate client connections (transports) with client IDs if needed globally,
  // or pass transport directly during subscription. This simplified version assumes transport is known at subscribe time.

  /**
   * Registers a new subscription initiated by a client.
   * @param subMessage The original SubscribeMessage.
   * @param clientId An identifier for the client connection.
   * @param transport The transport instance associated with this client.
   * @param cleanupFn The cleanup function returned by the subscription resolver.
   */
  addSubscription(
      subMessage: SubscribeMessage,
      clientId: string,
      transport: TypeQLTransport,
      // Use the correct union type here as well
      cleanupFn: Promise<() => void> | (() => void)
  ): void {
    const subId = subMessage.id;
    if (this.subscriptions.has(subId)) {
      console.warn(`[TypeQL SubManager] Subscription with ID ${subId} already exists. Overwriting.`);
       // Ensure old cleanup is called before overwriting
        this.removeSubscription(subId);
    }
    this.subscriptions.set(subId, { clientId, subscriptionId: subId, transport, cleanupFn });
    console.log(`[TypeQL Server] Client ${clientId} started subscription ${subId} for path ${subMessage.path}`);
  }

  /**
   * Removes a subscription and executes its cleanup function.
   * @param subscriptionId The ID of the subscription to remove.
   */
  removeSubscription(subscriptionId: number | string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) {
      this.subscriptions.delete(subscriptionId);
        console.log(`[TypeQL SubManager] Removed subscription ${subscriptionId} for client ${subscription.clientId}.`);
        // Execute cleanup, handling potential promise
        try {
           const cleanupTask = subscription.cleanupFn; // Get the function or promise
           // Check if it's a function before calling directly
           if (typeof cleanupTask === 'function') {
               cleanupTask(); // Call synchronous cleanup
           } else if (cleanupTask instanceof Promise) {
                // If it's a promise, await it, then call the resolved function
               cleanupTask.then(finalCleanupFn => {
                   if (typeof finalCleanupFn === 'function') {
                       finalCleanupFn();
                   }
               }).catch(err => {
                   console.error(`[TypeQL SubManager] Async cleanup promise error for subscription ${subscriptionId}:`, err);
               });
           }
        } catch (err) {
            // Catch synchronous errors from accessing cleanupFn itself (less likely)
           // Catch synchronous errors from calling cleanupFn itself
          console.error(`[TypeQL SubManager] Error during cleanup for subscription ${subscriptionId}:`, err);
      }
    } else {
      console.warn(`[TypeQL SubManager] Attempted to remove non-existent subscription ID: ${subscriptionId}`);
    }
  }

   /**
   * Removes all subscriptions associated with a specific client ID and executes their cleanup.
   * @param clientId The ID of the client whose subscriptions should be removed.
   */
  removeClientSubscriptions(clientId: string): void {
    let count = 0;
    const subsToRemove: (number | string)[] = [];
    this.subscriptions.forEach((subscription, subId) => {
      if (subscription.clientId === clientId) {
        subsToRemove.push(subId);
      }
    });

    subsToRemove.forEach(subId => {
      this.removeSubscription(subId); // This handles cleanup and deletion
      count++;
    });

    if (count > 0) {
      console.log(`[TypeQL SubManager] Removed ${count} subscriptions for disconnected client ${clientId}.`);
    }
  }


  /**
   * Retrieves the transport associated with a specific subscription ID.
   * @param subscriptionId The ID of the subscription.
   * @returns The transport instance or undefined if the subscription doesn't exist.
   */
  getTransportForSubscription(subscriptionId: number | string): TypeQLTransport | undefined {
    return this.subscriptions.get(subscriptionId)?.transport;
  }

  // Removed getSubscriber - if needed, can be added back.
  // Removed publishSubscriptionData - Publishing is now handled by the caller (requestHandler) via context/transport.
}
