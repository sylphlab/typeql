import { Transport, UpdateMessage } from '../core/types';

/**
 * Represents a subscriber client connection.
 * Includes a unique ID and the transport mechanism to send messages back.
 */
interface Subscriber {
  clientId: string;
  transport: Transport; // Or a specific server-side transport representation
}

/**
 * Manages client subscriptions to various topics on the server side.
 * Allows adding, removing subscriptions, and retrieving subscribers for a topic.
 */
export class SubscriptionManager {
  // Map where keys are topics and values are Sets of client IDs subscribed to that topic.
  private subscriptions: Map<string, Set<string>> = new Map();
  // Map where keys are client IDs and values are Subscriber objects (containing transport).
  private clients: Map<string, Subscriber> = new Map();

  /**
   * Registers a new client connection.
   * @param clientId A unique identifier for the client.
   * @param transport The transport object associated with the client, used for sending messages.
   */
  addClient(clientId: string, transport: Transport): void {
    if (this.clients.has(clientId)) {
      console.warn(`[ReqDelta Server] Client with ID ${clientId} already exists. Overwriting.`);
    }
    this.clients.set(clientId, { clientId, transport });
    console.log(`[ReqDelta Server] Client connected: ${clientId}`);
  }

  /**
   * Removes a client connection and all its subscriptions.
   * @param clientId The ID of the client to remove.
   */
  removeClient(clientId: string): void {
    if (!this.clients.has(clientId)) {
      return; // Client not found
    }
    this.clients.delete(clientId);
    // Remove client from all topic subscriptions
    this.subscriptions.forEach((subscribers, topic) => {
      if (subscribers.delete(clientId)) {
        console.log(`[ReqDelta Server] Client ${clientId} unsubscribed from topic ${topic} due to disconnect.`);
        // Optional: Clean up empty topics
        if (subscribers.size === 0) {
          this.subscriptions.delete(topic);
          console.log(`[ReqDelta Server] Topic ${topic} has no subscribers, removing.`);
        }
      }
    });
    console.log(`[ReqDelta Server] Client disconnected: ${clientId}`);
  }

  /**
   * Subscribes a client to a specific topic.
   * @param clientId The ID of the client subscribing.
   * @param topic The topic to subscribe to.
   */
  subscribe(clientId: string, topic: string): void {
    if (!this.clients.has(clientId)) {
      console.warn(`[ReqDelta Server] Attempted to subscribe non-existent client ID: ${clientId} to topic: ${topic}`);
      return;
    }
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
    }
    const subscribers = this.subscriptions.get(topic)!;
    if (!subscribers.has(clientId)) {
      subscribers.add(clientId);
      console.log(`[ReqDelta Server] Client ${clientId} subscribed to topic: ${topic}`);
    } else {
       console.log(`[ReqDelta Server] Client ${clientId} already subscribed to topic: ${topic}`);
    }
  }

  /**
   * Unsubscribes a client from a specific topic.
   * @param clientId The ID of the client unsubscribing.
   * @param topic The topic to unsubscribe from.
   */
  unsubscribe(clientId: string, topic: string): void {
     if (!this.clients.has(clientId)) {
       // This might happen if unsubscribe message arrives after disconnect
       console.log(`[ReqDelta Server] Attempted to unsubscribe non-existent or already disconnected client ID: ${clientId} from topic: ${topic}`);
       return;
     }
    const subscribers = this.subscriptions.get(topic);
    if (subscribers && subscribers.delete(clientId)) {
      console.log(`[ReqDelta Server] Client ${clientId} unsubscribed from topic: ${topic}`);
      // Optional: Clean up empty topics
      if (subscribers.size === 0) {
        this.subscriptions.delete(topic);
        console.log(`[ReqDelta Server] Topic ${topic} has no subscribers, removing.`);
      }
    } else {
       console.log(`[ReqDelta Server] Client ${clientId} was not subscribed to topic: ${topic} or topic doesn't exist.`);
    }
  }

  /**
   * Retrieves all active subscribers (client transport) for a given topic.
   * @param topic The topic to get subscribers for.
   * @returns An array of Subscriber objects.
   */
  getSubscribers(topic: string): Subscriber[] {
    const subscriberIds = this.subscriptions.get(topic);
    if (!subscriberIds) {
      return []; // No subscribers for this topic
    }
    const subscribers: Subscriber[] = [];
    subscriberIds.forEach(clientId => {
      const client = this.clients.get(clientId);
      if (client) {
        subscribers.push(client);
      } else {
        // Should ideally not happen if cleanup is correct, but good to handle
        console.warn(`[ReqDelta Server] Client ID ${clientId} found in topic ${topic} subscriptions but not in client list. Cleaning up.`);
        subscriberIds.delete(clientId); // Remove inconsistent entry
      }
    });
    return subscribers;
  }

  /**
   * Sends an update message to all subscribers of a specific topic.
   * @param topic The topic the update belongs to.
   * @param delta The delta data to send.
   */
  publishUpdate<D = any>(topic: string, delta: D): void {
    const subscribers = this.getSubscribers(topic);
    if (subscribers.length === 0) {
      return; // No one to send to
    }

    const updateMsg: UpdateMessage<D> = {
      type: 'update',
      topic: topic,
      delta: delta,
    };

    console.log(`[ReqDelta Server] Publishing update to ${subscribers.length} subscribers for topic: ${topic}`);
    subscribers.forEach(subscriber => {
      try {
         // Transport might return a promise or be sync
         Promise.resolve(subscriber.transport.sendMessage(updateMsg)).catch(err => {
            console.error(`[ReqDelta Server] Error sending update to client ${subscriber.clientId} for topic "${topic}":`, err);
            // Optional: Handle send errors, e.g., mark client for removal if transport fails repeatedly
         });
      } catch (err) {
         console.error(`[ReqDelta Server] Error sending update to client ${subscriber.clientId} for topic "${topic}":`, err);
      }
    });
  }
}
