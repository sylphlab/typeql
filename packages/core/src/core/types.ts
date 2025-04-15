/**
 * Represents the standardized message structure for ReqDelta communication.
 */
export type MessageBase<T extends string, P = unknown> = {
  /** The type of the message. */
  type: T;
  /** A unique identifier for request/response correlation or subscription management. */
  id?: string;
  /** The topic this message relates to. */
  topic?: string;
  /** The main data payload of the message. */
  payload?: P;
};

/**
 * Message sent from Client to Server to request initial state for a topic.
 */
export type RequestMessage<P = unknown> = MessageBase<'request', P> & Required<Pick<MessageBase<'request'>, 'id' | 'topic'>>;

/**
 * Message sent from Server to Client in response to a RequestMessage.
 */
export type ResponseMessage<P = unknown> = MessageBase<'response', P> & Required<Pick<MessageBase<'response'>, 'id' | 'topic'>> & {
  /** Optional error message if the request failed. */
  error?: string;
};

/**
 * Message sent from Client to Server to subscribe to updates for a topic.
 */
export type SubscribeMessage = MessageBase<'subscribe'> & Required<Pick<MessageBase<'subscribe'>, 'id' | 'topic'>>;

/**
 * Message sent from Client to Server to unsubscribe from updates for a topic.
 */
export type UnsubscribeMessage = MessageBase<'unsubscribe'> & Required<Pick<MessageBase<'unsubscribe'>, 'id' | 'topic'>>;

/**
 * Message sent from Server to Client with incremental updates for a topic.
 */
export type UpdateMessage<D = unknown> = MessageBase<'update', D> & Required<Pick<MessageBase<'update'>, 'topic'>> & { // Also corrected MessageBase here to include Delta type
  /** The incremental delta data. */
  delta: D;
};

/**
 * Union type representing all possible ReqDelta messages.
 */
export type ReqDeltaMessage<ReqP = any, ResP = any, Delta = any> =
  | RequestMessage<ReqP>
  | ResponseMessage<ResP>
  | SubscribeMessage
  | UnsubscribeMessage
  | UpdateMessage<Delta>;

/**
 * Interface defining the contract for transport layer adapters.
 * Transport adapters are responsible for sending and receiving messages
 * over a specific communication channel (e.g., WebSocket, postMessage).
 */
export interface Transport {
  /**
   * Sends a message payload over the transport channel.
   * Can be synchronous or asynchronous.
   * @param payload The message payload to send (should be serializable).
   */
  sendMessage(payload: ReqDeltaMessage): Promise<void> | void;

  /**
   * Registers a callback to be invoked when a message is received.
   * @param callback The function to call with the received payload.
   * @returns An optional cleanup function to unregister the callback or perform other cleanup.
   */
  onMessage(callback: (payload: ReqDeltaMessage) => void): (() => void) | void;
}
