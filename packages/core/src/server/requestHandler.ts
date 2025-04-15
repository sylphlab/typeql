import {
  Transport,
  ReqDeltaMessage,
  RequestMessage,
  ResponseMessage,
  SubscribeMessage,
  UnsubscribeMessage,
} from '../core/types';
import { SubscriptionManager } from './subscriptionManager';

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

/**
 * Configuration options for the RequestHandler.
 */
export interface RequestHandlerOptions<ReqP = any, ResP = any> {
  /** An instance of the SubscriptionManager. */
  subscriptionManager: SubscriptionManager;
  /** A function that retrieves the initial data for a requested topic. */
  fetchData: DataFetcher<ReqP, ResP>;
}

/**
 * Handles incoming messages on the server side, processing requests,
 * subscriptions, and unsubscriptions.
 */
export class RequestHandler<ReqP = any, ResP = any> {
  private subscriptionManager: SubscriptionManager;
  private fetchData: DataFetcher<ReqP, ResP>;

  constructor(options: RequestHandlerOptions<ReqP, ResP>) {
    this.subscriptionManager = options.subscriptionManager;
    this.fetchData = options.fetchData;
  }

  /**
   * Processes a single incoming message from a specific client.
   * @param clientId The ID of the client sending the message.
   * @param clientTransport The transport associated with the sending client.
   * @param message The incoming ReqDelta message.
   */
  async handleMessage(
    clientId: string,
    clientTransport: Transport, // Used to send response back
    message: ReqDeltaMessage<ReqP, any, any> // Input ReqP, Output ResP (but receiver handles any ResP)
  ): Promise<void> {
    if (!message.topic) {
        console.warn(`[ReqDelta Server] Received message without topic from client ${clientId}:`, message);
        // Optionally send an error response if the message type expects a topic (e.g., request, subscribe)
        return;
    }

    switch (message.type) {
      case 'request':
        await this.handleRequest(clientId, clientTransport, message as RequestMessage<ReqP>);
        break;
      case 'subscribe':
        this.handleSubscribe(clientId, message as SubscribeMessage);
        // Optional: Send confirmation back to client? Design decision.
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(clientId, message as UnsubscribeMessage);
        // Optional: Send confirmation back to client? Design decision.
        break;
      // Ignore 'response' and 'update' types received by the server
      case 'response':
      case 'update':
         console.warn(`[ReqDelta Server] Received unexpected message type "${message.type}" from client ${clientId}. Ignoring.`);
         break;
      default:
        console.warn(`[ReqDelta Server] Received unknown message type from client ${clientId}:`, message);
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

    if (!id) {
        console.warn(`[ReqDelta Server] Received 'request' message without ID from client ${clientId}. Ignoring.`);
        return; // Cannot respond without request ID
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
        // No payload on error
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
    this.subscriptionManager.subscribe(clientId, message.topic);
     // Optional: Acknowledge subscription via message back to client using message.id?
  }

  /**
   * Handles an incoming 'unsubscribe' message.
   */
  private handleUnsubscribe(clientId: string, message: UnsubscribeMessage): void {
    this.subscriptionManager.unsubscribe(clientId, message.topic);
     // Optional: Acknowledge unsubscription via message back to client using message.id?
  }
}
