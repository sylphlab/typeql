import {
  Transport,
  RequestMessage,
  ResponseMessage,
  SubscribeMessage,
  UnsubscribeMessage, // Added missing import
  UpdateMessage,
  ReqDeltaMessage,
} from '../core/types';
import { generateId } from '../core/utils'; // Assuming utils.ts exists for ID generation

// Define the shape of the store's state
export interface StoreState<T = any> {
  /** The current data state. */
  data: T | undefined;
  /** Indicates if the initial state is currently being loaded. */
  isLoading: boolean;
  /** Stores any error that occurred during request or update application. */
  error: string | Error | undefined;
}

// Define the options for creating a store
export interface CreateStoreOptions<T = any, ReqP = any, Delta = any> {
  /** The transport adapter instance. */
  transport: Transport;
  /** The topic to subscribe to. */
  topic: string;
  /** Optional initial data state. */
  initialData?: T;
  /** Optional payload for the initial request. */
  requestPayload?: ReqP;
  /**
   * Function to apply incoming deltas to the current state.
   * Must return the new state.
   * @param currentState The current state.
   * @param delta The incoming delta.
   * @returns The new state after applying the delta.
   */
  applyDelta: (currentState: T | undefined, delta: Delta) => T;
  /** Optional function to generate unique request IDs. Defaults to a simple generator. */
  generateRequestId?: () => string;
}

// Define the interface for the created store instance
export interface ReqDeltaStore<T = any> {
  /** Get the current state of the store. */
  getState: () => Readonly<StoreState<T>>;
  /**
   * Subscribe to state changes.
   * @param listener The callback function to invoke when the state changes.
   * @returns A function to unsubscribe the listener.
   */
  subscribe: (listener: (state: Readonly<StoreState<T>>) => void) => () => void;
  /** Force a refresh by re-requesting the initial state. */
  refresh: () => void;
  /** Disconnect the store and clean up resources (e.g., unsubscribe). */
  disconnect: () => void;
}

/**
 * Creates a ReqDelta client store for managing state synchronized with a server topic.
 *
 * @param options Configuration options for the store.
 * @returns A ReqDeltaStore instance.
 */
export function createStore<T = any, ReqP = any, ResP = any, Delta = any>(
  options: CreateStoreOptions<T, ReqP, Delta>
): ReqDeltaStore<T> {
  const {
    transport,
    topic,
    initialData,
    requestPayload,
    applyDelta,
    generateRequestId = generateId,
  } = options;

  let state: StoreState<T> = {
    data: initialData,
    isLoading: false,
    error: undefined,
  };

  const listeners = new Set<(state: Readonly<StoreState<T>>) => void>();

  let cleanupTransport: (() => void) | void | undefined;
  let isConnected = true; // Flag to prevent operations after disconnect

  const setState = (newState: Partial<StoreState<T>>) => {
    state = { ...state, ...newState };
    listeners.forEach(listener => listener(Object.freeze({ ...state }))); // Notify listeners with immutable state
  };

  const handleIncomingMessage = (message: ReqDeltaMessage<any, ResP, Delta>) => {
    if (!isConnected || message.topic !== topic) {
      return; // Ignore messages if disconnected or for a different topic
    }

    switch (message.type) {
      case 'response':
        // Handle response to initial request
        if (message.error) {
          setState({ isLoading: false, error: message.error, data: undefined }); // Clear data on error
        } else {
          setState({ isLoading: false, data: message.payload as T, error: undefined });
        }
        break;

      case 'update':
        // Handle incremental update
        try {
          const newData = applyDelta(state.data, message.delta);
          setState({ data: newData, error: undefined }); // Clear previous error on successful update
        } catch (err) {
          console.error(`[ReqDelta] Error applying delta for topic "${topic}":`, err);
          setState({ error: err instanceof Error ? err : new Error(String(err)) });
        }
        break;

      // Ignore other message types ('request', 'subscribe', 'unsubscribe') on the client store
      default:
        break;
    }
  };

  const requestInitialState = () => {
    if (!isConnected) return;
    setState({ isLoading: true, error: undefined });
    const requestId = generateRequestId();
    // Explicitly handle undefined payload if requestPayload is optional
    const requestMsg: RequestMessage<ReqP> = {
      type: 'request',
      id: requestId,
      topic: topic,
      ...(requestPayload !== undefined && { payload: requestPayload }), // Only include payload if defined
    };
    try {
      // Transport might return a promise or be sync
      Promise.resolve(transport.sendMessage(requestMsg)).catch(err => {
         console.error(`[ReqDelta] Error sending request message for topic "${topic}":`, err);
         // Potentially set an error state here if sending fails critically
         setState({ isLoading: false, error: new Error(`Failed to send request: ${err}`) });
      });
    } catch (err) {
       console.error(`[ReqDelta] Error sending request message for topic "${topic}":`, err);
       setState({ isLoading: false, error: new Error(`Failed to send request: ${err}`) });
    }
  };

  const subscribeToUpdates = () => {
    if (!isConnected) return;
    const subscribeId = generateRequestId();
    const subscribeMsg: SubscribeMessage = {
      type: 'subscribe',
      id: subscribeId, // ID might be used by server to confirm subscription
      topic: topic,
    };
     try {
       Promise.resolve(transport.sendMessage(subscribeMsg)).catch(err => {
          console.error(`[ReqDelta] Error sending subscribe message for topic "${topic}":`, err);
          // Subscription failure might warrant an error state or retry logic
       });
     } catch (err) {
        console.error(`[ReqDelta] Error sending subscribe message for topic "${topic}":`, err);
     }
  };

   const unsubscribeFromUpdates = () => {
    // No need to check isConnected here, as this is part of disconnect logic
    const unsubscribeId = generateRequestId();
    // Corrected typo: UnsubscribeMessage
    const unsubscribeMsg: UnsubscribeMessage = {
      type: 'unsubscribe',
      id: unsubscribeId,
      topic: topic,
    };
    try {
      // Best effort to unsubscribe, errors less critical during cleanup
      Promise.resolve(transport.sendMessage(unsubscribeMsg)).catch(err => {
         console.warn(`[ReqDelta] Error sending unsubscribe message for topic "${topic}" during disconnect:`, err);
      });
    } catch (err) {
       console.warn(`[ReqDelta] Error sending unsubscribe message for topic "${topic}" during disconnect:`, err);
    }
  };

  // --- Initialization ---
  cleanupTransport = transport.onMessage(handleIncomingMessage);
  requestInitialState();
  subscribeToUpdates();
  // --- End Initialization ---


  // --- Store API ---
  const storeApi: ReqDeltaStore<T> = {
    getState: () => Object.freeze({ ...state }), // Return immutable state
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => {
        if (isConnected) {
            requestInitialState(); // Re-request initial state
            // Optional: Consider if re-subscription is needed depending on server logic
        } else {
            console.warn(`[ReqDelta] Cannot refresh store for topic "${topic}" as it is disconnected.`);
        }
    },
    disconnect: () => {
      if (!isConnected) return;
      isConnected = false;
      unsubscribeFromUpdates();
      if (typeof cleanupTransport === 'function') {
        cleanupTransport();
      }
      listeners.clear(); // Clear listeners
      // Optionally reset state
      // setState({ data: undefined, isLoading: false, error: new Error("Disconnected") });
      console.log(`[ReqDelta] Store disconnected for topic "${topic}".`);
    },
  };

  return storeApi;
}
