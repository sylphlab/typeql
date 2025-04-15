/**
// --- TypeQL Transport & Message Types ---

/** Common structure for request/response correlation */
interface CorrelatedMessage {
    /** Unique ID for correlating requests and responses. */
    id: number | string;
}

// --- Request/Response (Query/Mutation) ---

/** Message sent from Client to Server for a query or mutation. */
export interface ProcedureCallMessage extends CorrelatedMessage {
    type: 'query' | 'mutation';
    /** Path to the procedure (e.g., 'user.get'). */
    path: string;
    /** Input data for the procedure (if any). */
    input?: unknown;
}

/** Represents a successful procedure result from the server. */
interface ProcedureSuccessResult {
    type: 'data';
    /** The data returned by the procedure. */
    data: unknown;
}

/** Represents an error result from the server. */
interface ProcedureErrorResult {
    type: 'error';
    /** Error details. */
    error: {
        message: string;
        code?: string; // e.g., 'BAD_REQUEST', 'UNAUTHORIZED', 'INTERNAL_SERVER_ERROR'
        // path?: string; // Optional path where error occurred
        // stack?: string; // Optional stack trace in dev
    };
}

/** Message sent from Server to Client with the result of a query or mutation. */
export interface ProcedureResultMessage extends CorrelatedMessage {
    result: ProcedureSuccessResult | ProcedureErrorResult;
}


// --- Subscriptions ---

/** Message sent from Client to Server to start a subscription. */
export interface SubscribeMessage extends CorrelatedMessage {
    type: 'subscription';
    /** Path to the subscription procedure. */
    path: string;
    /** Input data for the subscription (if any). */
    input?: unknown;
}

/** Message sent from Client to Server to stop a subscription. */
export interface UnsubscribeMessage extends CorrelatedMessage {
    type: 'subscriptionStop';
    // ID refers to the original SubscribeMessage ID
}

/** Message sent from Server to Client with data for an active subscription. */
export interface SubscriptionDataMessage extends CorrelatedMessage {
    type: 'subscriptionData';
    // ID refers to the original SubscribeMessage ID
    /** The data payload (e.g., initial state or delta). */
    data: unknown;
    /** Optional sequence number for delta subscriptions. */
    seq?: number;
}

/** Message sent from Server to Client indicating a subscription has ended normally. */
export interface SubscriptionEndMessage extends CorrelatedMessage {
    type: 'subscriptionEnd';
    // ID refers to the original SubscribeMessage ID
}

/** Message sent from Server to Client indicating an error occurred on the subscription. */
export interface SubscriptionErrorMessage extends CorrelatedMessage {
    type: 'subscriptionError';
    // ID refers to the original SubscribeMessage ID
    /** Error details. */
    error: {
        message: string;
        code?: string;
        // path?: string;
    };
}

/** Union of all messages involved in the subscription lifecycle (client->server and server->client). */
export type SubscriptionLifecycleMessage =
    | SubscribeMessage
    | UnsubscribeMessage
    | SubscriptionDataMessage
    | SubscriptionEndMessage
    | SubscriptionErrorMessage;

// --- Transport Interface ---

/** Function to unsubscribe from a subscription. */
export type UnsubscribeFn = () => void;

/** Callbacks for handling subscription events from the server. */
export interface SubscriptionHandlers {
    /** Called when data is received for the subscription. */
    onData: (message: SubscriptionDataMessage) => void;
    /** Called when an error occurs on the subscription. */
    onError: (error: SubscriptionErrorMessage['error']) => void;
    /** Called when the subscription ends normally. */
    onEnd: () => void;
    /** Optional: Called when the transport confirms the subscription has started (e.g., server acknowledgment). */
    onStart?: () => void;
}

/**
 * Interface defining the contract for transport layer adapters in TypeQL.
 * Transport adapters handle the low-level communication.
 */
export interface TypeQLTransport {
    /**
     * Sends a query or mutation request and returns the result.
     * Handles serialization, sending, correlation, and deserialization.
     * @param message The procedure call message.
     * @returns A promise resolving with the procedure result message.
     */
    request(message: ProcedureCallMessage): Promise<ProcedureResultMessage>;

    /**
     * Initiates a subscription and registers handlers for incoming data/events.
     * Handles serialization, sending the subscribe message, and routing incoming
     * subscription messages (data, error, end) to the correct handlers based on ID.
     * @param message The subscription initiation message.
     * @param handlers Callbacks for subscription events.
     * @returns A function to call to unsubscribe and clean up the subscription.
     */
    subscribe(message: SubscribeMessage, handlers: SubscriptionHandlers): UnsubscribeFn;

    // Optional connection status management (similar to previous Transport)
    readonly connected?: boolean;
    onConnectionChange?(handler: (connected: boolean) => void): (() => void) | void;
    connect?(): Promise<void> | void; // Optional connect method
    disconnect?(): Promise<void> | void; // Optional disconnect method

    /**
     * Optional: Sends a subscription-related message from the server back to the client.
     * This is primarily used by the request handler's `publish` function.
     * The transport implementation must route the message to the correct client based
     * on the `id` within the message, which corresponds to the original subscription ID.
     * @param message The subscription data, error, or end message.
     */
    send?(message: SubscriptionDataMessage | SubscriptionErrorMessage | SubscriptionEndMessage): void | Promise<void>;
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


// --- Custom Error Type ---

/** Custom error class for TypeQL client-side errors. */
export class TypeQLClientError extends Error {
  // Explicitly include undefined for exactOptionalPropertyTypes compatibility
  public readonly code?: string | undefined;

  constructor(message: string, code?: string | undefined) {
    super(message);
    this.name = 'TypeQLClientError';
    this.code = code;
    // Ensure prototype chain is correct
    Object.setPrototypeOf(this, TypeQLClientError.prototype);
  }
}
