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
  /** Server-assigned sequence number for this update. */
  serverSeq?: number; // Made optional for initial phase, required for phase 2
  /** The sequence number of the update immediately preceding this one. Used for gap detection. */
  prevServerSeq?: number; // Optional
  /** Timestamp (e.g., Date.now()) when the update was generated on the server. */
  timestamp?: number; // Optional for now
};

/**
 * Message sent from Client to Server submitting an optimistic update.
 */
export type ClientUpdateMessage<D = unknown> = MessageBase<'client_update', D> & Required<Pick<MessageBase<'client_update'>, 'topic'>> & {
    /** Client-assigned sequence number for this update. */
    clientSeq: number;
    /** The optimistic delta data. */
    delta: D;
    /** Timestamp (e.g., Date.now()) when the update was generated on the client. */
    timestamp: number;
};

/**
 * Message sent from Server to Client acknowledging a ClientUpdateMessage.
 */
export type ServerAckMessage = MessageBase<'ack'> & Required<Pick<MessageBase<'ack'>, 'id'>> & { // ID corresponds to clientSeq
    /** The client sequence number being acknowledged. */
    clientSeq: number;
    /** Indicates if the server successfully applied the update. */
    success: boolean;
    /** If success is false, provides a reason for the failure/conflict. */
    conflictReason?: string;
    /** Server-assigned sequence number if the update was successful. */
    serverSeq?: number;
    /** Timestamp (e.g., Date.now()) when the ack was generated on the server. */
    serverTimestamp: number;
};

/**
 * Message sent from Client to Server requesting missing updates in a sequence range.
 */
export type MissingUpdatesRequestMessage = MessageBase<'missing_updates'> & Required<Pick<MessageBase<'missing_updates'>, 'topic'>> & {
    /** The last server sequence number the client successfully processed. */
    fromSeq: number;
    /** The server sequence number the client detected (creating the gap). */
    toSeq: number;
};


/**
 * Union type representing all possible ReqDelta messages.
 * Includes new types for optimistic updates and consistency.
 */
export type ReqDeltaMessage<ReqP = any, ResP = any, Delta = any> =
  | RequestMessage<ReqP>
  | ResponseMessage<ResP>
  | SubscribeMessage
  | UnsubscribeMessage
  | UpdateMessage<Delta>
  | ClientUpdateMessage<Delta> // Added
  | ServerAckMessage           // Added
  | MissingUpdatesRequestMessage; // Added

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

  // Optional connection status
  readonly connected?: boolean;
  onConnectionChange?(handler: (connected: boolean) => void): (() => void) | void;
}


// --- Standard Delta Types ---

/** Represents adding an item to a collection (array). Assumes collection items have an 'id'. */
export interface AddDelta<T extends { id: string }> {
  type: 'add';
  /** The item to add. */
  item: T;
  /** Optional path to the target collection within the state. Defaults to root array. */
  path?: string[];
  /** Optional: Client's temporary ID for correlation during optimistic updates. */
  tempId?: string;
}

/** Represents updating properties of an existing item in a collection. Assumes collection items have an 'id'. */
export interface UpdateDelta<T extends { id: string }> {
  type: 'update';
  /** The ID of the item to update. */
  id: string;
  /** The partial changes to apply. */
  changes: Partial<T>;
  /** Optional path to the target collection within the state. Defaults to root array. */
  path?: string[];
}

/** Represents removing an item from a collection. Assumes collection items have an 'id'. */
export interface RemoveDelta {
  type: 'remove';
  /** The ID of the item to remove. */
  id: string;
  /** Optional path to the target collection within the state. Defaults to root array. */
  path?: string[];
}

/** Represents replacing the entire state or a sub-part of it. */
export interface ReplaceDelta<S> {
  type: 'replace';
  /** The new state or sub-state. */
  state: S;
  /** Optional path to the target location within the state. Defaults to root. */
  path?: string[];
}

// TODO: Consider adding 'move', 'patch' (JSON Patch)

/**
 * A union type for common standard delta operations, primarily for collections of items with an 'id'.
 * Can be extended by applications with custom delta types.
 */
export type StandardDelta<T extends { id: string }, S = any> =
  | AddDelta<T>
  | UpdateDelta<T>
  | RemoveDelta
  | ReplaceDelta<S>;


// --- Standard Operation Types (for Client Actions) ---

/** Represents a client operation to add an item optimistically. */
export interface AddOperation<T extends { id: string }> {
    type: 'add';
    /** The partial item data (server typically assigns final ID and other fields). */
    item: Partial<T>;
    /** Client-generated temporary ID for optimistic updates. */
    tempId: string;
    /** Optional path to the target collection within the state. */
    path?: string[];
}

/** Represents a client operation to update an item optimistically. */
export interface UpdateOperation<T extends { id: string }> {
    type: 'update';
    /** The ID of the item to update. */
    id: string;
    /** The partial changes to apply. */
    changes: Partial<T>;
    /** Optional path to the target collection within the state. */
    path?: string[];
}

/** Represents a client operation to remove an item optimistically. */
export interface RemoveOperation {
    type: 'remove';
    /** The ID of the item to remove. */
    id: string;
    /** Optional path to the target collection within the state. */
    path?: string[];
}

// TODO: Consider 'move' operation

/**
 * A union type for common standard client operations intended for optimistic updates.
 * These operations are typically converted into StandardDelta for local application and sending to the server.
 */
export type StandardOperation<T extends { id: string }> =
  | AddOperation<T>
  | UpdateOperation<T>
  | RemoveOperation;
