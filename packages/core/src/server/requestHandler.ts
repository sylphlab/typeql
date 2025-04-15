import {
  Transport,
  ReqDeltaMessage,
  RequestMessage,
  ResponseMessage,
  SubscribeMessage,
  UnsubscribeMessage,
  MissingUpdatesRequestMessage, // Added
  UpdateMessage, // Added
  // Other potential relevant types like ClientUpdateMessage if handling those here too
} from '../core/types';
import { SubscriptionManager } from './subscriptionManager';
import type { UpdateHistory } from './updateHistory'; // Added

/**
 * Defines the function signature for fetching initial state data for a topic.
 * This function is provided by the server application logic.
 * @param topic The topic for which initial state is requested.
 * @param payload Optional payload from the client's request message.
 * @param clientId The ID of the client making the request.
 * @returns A Promise resolving to the initial state data, or rejecting with an error.
 */
export type DataFetcher<ReqP = any, ResP = any> = (
  topic: string,
  payload: ReqP | undefined,
  clientId: string
) => Promise<ResP>;

// TODO: Define types for handling client operations if RequestHandler expands scope
// export type OperationHandler<Op = any, Delta = any> = (
//   topic: string,
//   operation: Op,
//   clientId: string
// ) => Promise<Delta | null>; // Returns delta to broadcast, or null if op is invalid/rejected

/**
 * Configuration options for the RequestHandler.
 */
export interface RequestHandlerOptions<ReqP = any, ResP = any, Delta = any> {
  /** An instance of the SubscriptionManager. */
  subscriptionManager: SubscriptionManager;
  /** A function that retrieves the initial data for a requested topic. */
  fetchData: DataFetcher<ReqP, ResP>;
  /** Optional: An instance of the UpdateHistory for handling missing updates. */
  updateHistory?: UpdateHistory<Delta>;
  // TODO: Add operationHandler if handling client_update messages here
  // operationHandler?: OperationHandler<any, Delta>;
  // TODO: Add server sequence manager if needed here
  // serverSequenceManager?: ServerSequenceManager;
}

/**
 * Handles incoming messages on the server side, processing requests,
 * subscriptions, unsubscriptions, and potentially client operations and recovery requests.
 */
export class RequestHandler<ReqP = any, ResP = any, Delta = any> {
  private subscriptionManager: SubscriptionManager;
  private fetchData: DataFetcher<ReqP, ResP>;
  private updateHistory?: UpdateHistory<Delta>; // Added
  // private operationHandler?: OperationHandler<any, Delta>; // Added
  // private serverSequenceManager?: ServerSequenceManager; // Added

  constructor(options: RequestHandlerOptions<ReqP, ResP, Delta>) {
    this.subscriptionManager = options.subscriptionManager;
    this.fetchData = options.fetchData;
    this.updateHistory = options.updateHistory; // Added
    // this.operationHandler = options.operationHandler; // Added
    // this.serverSequenceManager = options.serverSequenceManager; // Added
  }

  /**
   * Processes a single incoming message from a specific client.
   * @param clientId The ID of the client sending the message.
   * @param clientTransport The transport associated with the sending client.
   * @param message The incoming ReqDelta message.
   */
  async handleMessage(
    clientId: string,
    clientTransport: Transport, // Used to send response/updates back
    message: ReqDeltaMessage<ReqP, any, any> // Input ReqP, Delta, ClientOp; Output ResP, Delta
  ): Promise<void> {
    // Topic is required for most messages relevant to RequestHandler
    if (!message.topic && (message.type === 'request' || message.type === 'subscribe' || message.type === 'unsubscribe' || message.type === 'missing_updates' || message.type === 'client_update')) {
        console.warn(`[ReqDelta Server] Received message type "${message.type}" without topic from client ${clientId}:`, message);
        // Optionally send an error response back to client?
        return;
    }

    switch (message.type) {
      case 'request':
        await this.handleRequest(clientId, clientTransport, message as RequestMessage<ReqP>);
        break;
      case 'subscribe':
        // Ensure topic exists before handling
        if (message.topic) {
             this.handleSubscribe(clientId, message as SubscribeMessage);
        }
        break;
      case 'unsubscribe':
         // Ensure topic exists before handling
        if (message.topic) {
            this.handleUnsubscribe(clientId, message as UnsubscribeMessage);
        }
        break;
      case 'missing_updates': // Added case
        // Ensure topic exists before handling
        if (message.topic) {
            await this.handleMissingUpdatesRequest(clientId, clientTransport, message as MissingUpdatesRequestMessage);
        }
        break;
      // TODO: Handle 'client_update' if RequestHandler manages operations
      // case 'client_update':
      //   if (message.topic) {
      //       await this.handleClientUpdate(clientId, clientTransport, message as ClientUpdateMessage<any>);
      //   }
      //   break;
      // Ignore 'response' and 'update' types received by the server
      case 'response':
      case 'update':
      case 'ack': // Server should not receive acks
         console.warn(`[ReqDelta Server] Received unexpected message type "${message.type}" from client ${clientId}. Ignoring.`);
         break;
      default:
        // Use exhaustive check pattern
        // const _exhaustiveCheck: never = message;
        console.warn(`[ReqDelta Server] Received unknown message type from client ${clientId}:`, (message as any)?.type);
        break;
    }
  }

  /**
   * Handles an incoming 'request' message.
   */
  private async handleRequest(
    clientId: string,
    clientTransport: Transport,
    message: RequestMessage<ReqP>
  ): Promise<void> {
    const { id, topic, payload } = message;

    if (!id || !topic) {
        console.warn(`[ReqDelta Server] Invalid 'request' message from client ${clientId}:`, message);
        return;
    }

    let response: ResponseMessage<ResP>;
    try {
      console.log(`[ReqDelta Server] Handling request for topic "${topic}" from client ${clientId} (ReqID: ${id})`);
      const data = await this.fetchData(topic, payload, clientId);
      response = {
        type: 'response',
        id: id,
        topic: topic,
        payload: data,
      };
    } catch (error) {
      console.error(`[ReqDelta Server] Error fetching data for topic "${topic}" for client ${clientId} (ReqID: ${id}):`, error);
      response = {
        type: 'response',
        id: id,
        topic: topic,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
       await Promise.resolve(clientTransport.sendMessage(response));
    } catch (sendError) {
       console.error(`[ReqDelta Server] Failed to send response for ReqID ${id} to client ${clientId}:`, sendError);
    }
  }

  /**
   * Handles an incoming 'subscribe' message.
   */
  private handleSubscribe(clientId: string, message: SubscribeMessage): void {
    // topic is guaranteed valid by caller (handleMessage)
    this.subscriptionManager.subscribe(clientId, message.topic!);
     console.log(`[ReqDelta Server] Client ${clientId} subscribed to topic "${message.topic}"`);
     // Optional: Acknowledge subscription via message back to client using message.id?
  }

  /**
   * Handles an incoming 'unsubscribe' message.
   */
  private handleUnsubscribe(clientId: string, message: UnsubscribeMessage): void {
    // topic is guaranteed valid by caller (handleMessage)
    this.subscriptionManager.unsubscribe(clientId, message.topic!);
    console.log(`[ReqDelta Server] Client ${clientId} unsubscribed from topic "${message.topic}"`);
     // Optional: Acknowledge unsubscription via message back to client using message.id?
  }

  /**
   * Handles an incoming 'missing_updates' message. Fetches updates from history
   * and sends them directly back to the requesting client.
   */
  private async handleMissingUpdatesRequest(
      clientId: string,
      clientTransport: Transport,
      message: MissingUpdatesRequestMessage
  ): Promise<void> {
      const { topic, fromSeq, toSeq } = message;
      // topic is guaranteed valid by caller (handleMessage)

      if (!this.updateHistory) {
          console.warn(`[ReqDelta Server] Received 'missing_updates' request for topic "${topic}" from client ${clientId}, but no update history is configured.`);
          // Optionally send an error response back?
          return;
      }

      if (typeof fromSeq !== 'number' || typeof toSeq !== 'number' || fromSeq >= toSeq) {
           console.warn(`[ReqDelta Server] Received invalid 'missing_updates' request range (${fromSeq} to ${toSeq}) for topic "${topic}" from client ${clientId}.`);
           // Optionally send an error response back?
           return;
      }

      console.log(`[ReqDelta Server] Handling missing_updates request for topic "${topic}" from client ${clientId} (Range: ${fromSeq} to ${toSeq})`);

      try {
          const updates = this.updateHistory.getUpdates(topic!, fromSeq, toSeq);

          if (updates.length === 0) {
              console.log(`[ReqDelta Server] No updates found in history for topic "${topic}" in range (${fromSeq}, ${toSeq}] for client ${clientId}.`);
              // Optionally send a confirmation that no updates were found? Or just do nothing.
              return;
          }

          console.log(`[ReqDelta Server] Sending ${updates.length} historical updates for topic "${topic}" to client ${clientId}.`);

          // Send each historical update individually
          // Consider batching if performance becomes an issue and transport supports it
          for (const update of updates) {
              // Ensure the message type is correct when sending
              const updateMsg: UpdateMessage<Delta> = {
                  type: 'update',
                  topic: topic!,
                  delta: update.delta,
                  serverSeq: update.serverSeq,
                  prevServerSeq: update.prevServerSeq, // Include if available in history
                  timestamp: update.timestamp, // Include if available in history
              };
               // Don't await each send individually unless absolutely necessary, fire them off
               Promise.resolve(clientTransport.sendMessage(updateMsg)).catch(sendError => {
                    console.error(`[ReqDelta Server] Failed to send historical update (Seq: ${update.serverSeq}) for topic "${topic}" to client ${clientId}:`, sendError);
                    // What to do if sending fails? Client might request again.
               });
          }

      } catch (error) {
           console.error(`[ReqDelta Server] Error retrieving updates from history for topic "${topic}" for client ${clientId} (Range: ${fromSeq} to ${toSeq}):`, error);
           // Optionally send an error response back to the client?
      }
  }

   // TODO: Implement handleClientUpdate if needed
   // private async handleClientUpdate(...) { ... }
}
