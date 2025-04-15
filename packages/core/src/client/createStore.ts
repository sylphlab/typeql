// packages/core/src/client/createStore.ts
// NOTE: Refactored to be a basic non-optimistic store aligned with TypeQL.
// Further features like optimistic updates would require a separate, more complex store (like the old optimisticStore).

import type {
    TypeQLTransport,
    ProcedureCallMessage,
    SubscribeMessage,
    SubscriptionHandlers,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage
} from '../core/types';
import { generateId } from '../core/utils';

// --- Types ---

/** State managed by the basic Store. */
export interface StoreState<State> {
    /** The current state. Undefined before first load or after error. */
    state: State | undefined;
    /** Indicates if the state is currently being loaded. */
    isLoading: boolean;
    /** Stores any error that occurred. */
    error: Error | null;
    /** Is the transport currently considered connected? */
    isConnected: boolean;
    /** Status of the subscription lifecycle. */
    subscriptionStatus: 'idle' | 'active' | 'error' | 'ended';
}

/** Options for creating a basic TypeQL Store. */
export interface CreateStoreOptions<
    State,
    QueryInput = unknown, // Input type for the initial state query
    SubscriptionInput = unknown, // Input type for the subscription
    SubscriptionOutput = unknown // Type of data received from subscription (can be State or Delta)
> {
    /** The transport adapter instance. */
    transport: TypeQLTransport;
    /** Path to the procedure for fetching initial state (query). */
    queryPath: string;
    /** Input for the initial state query (optional). */
    queryInput?: QueryInput;
    /** Path to the procedure for subscribing to updates. */
    subscriptionPath: string;
    /** Input for the subscription (optional). */
    subscriptionInput?: SubscriptionInput;
    /** Initial state value *before* loading. */
    initialState: State | undefined;
    /**
     * Function to apply incoming subscription data to the current state.
     * The 'data' parameter is the `data` field from `SubscriptionDataMessage`.
     * It might be the full state or a delta, depending on the backend procedure.
     * @param currentState The current state (can be undefined).
     * @param data The incoming data from the subscription message.
     * @returns The new state after applying the update.
     */
    applyUpdate: (currentState: State | undefined, data: SubscriptionOutput) => State;
    /** Optional function to generate unique request/message IDs. */
    generateRequestId?: () => string | number;
    /** Optional: Callback for connection status changes triggered by the store. */
    onStatusChange?: (status: Readonly<StoreState<State>>) => void;
    /** If true, re-fetches initial query and restarts subscription on reconnect. Default: false */
    refreshOnReconnect?: boolean;
}

/** Public API of the basic TypeQL Store. */
export interface TypeQLStore<State> {
    /** Get the current state of the store. */
    getState: () => Readonly<StoreState<State>>;
    /** Subscribe to state changes. */
    subscribe: (listener: (state: Readonly<StoreState<State>>) => void) => () => void;
    /** Force a refresh by re-requesting the initial state. */
    refresh: () => void;
    /** Disconnect the store and clean up resources. */
    disconnect: () => void;
}

// --- Implementation ---

export function createStore<
    State,
    QueryInput = unknown,
    SubscriptionInput = unknown,
    SubscriptionOutput = unknown
>(
    options: CreateStoreOptions<State, QueryInput, SubscriptionInput, SubscriptionOutput>
): TypeQLStore<State> {
    const {
        transport,
        queryPath,
        queryInput,
        subscriptionPath,
        subscriptionInput,
        initialState,
        applyUpdate,
        generateRequestId = generateId,
        onStatusChange, // Renamed from onConnectionChange
        refreshOnReconnect = false,
    } = options;

    let internalState: StoreState<State> = {
        state: initialState,
        isLoading: false,
        error: null,
        isConnected: transport.connected ?? false, // Start potentially disconnected
        subscriptionStatus: 'idle',
    };

    const listeners = new Set<(state: Readonly<StoreState<State>>) => void>();
    let unsubscribeFn: UnsubscribeFn | undefined;
    let cleanupConnectionListener: (() => void) | void | undefined;
    let isStoreActive = true; // Flag to prevent actions after disconnect

    // --- State Management ---
    const setState = (newState: Partial<StoreState<State>>) => {
        const previousState = internalState;
        internalState = { ...internalState, ...newState };
        // Prevent listeners/callbacks from being called after disconnect
        if (isStoreActive) {
            const frozenState = Object.freeze({ ...internalState });
            listeners.forEach(listener => listener(frozenState));
            // Call the status change callback if provided and state actually changed
            if (onStatusChange && JSON.stringify(previousState) !== JSON.stringify(internalState)) {
                 onStatusChange(frozenState);
            }
        }
    };

    // --- Subscription Handlers ---
    const handleSubscriptionData = (message: SubscriptionDataMessage) => {
        if (!isStoreActive) return;
        console.debug(`[TypeQL Store] Received subscription data for path "${subscriptionPath}".`);
        // Subscription is confirmed active on first data message
        if (internalState.subscriptionStatus !== 'active') {
             setState({ subscriptionStatus: 'active' });
        }
        try {
            const newState = applyUpdate(internalState.state, message.data as SubscriptionOutput);
            setState({ state: newState, error: null, isLoading: false }); // Ensure loading is false
        } catch (err: any) {
            console.error(`[TypeQL Store] Error applying subscription update for path "${subscriptionPath}":`, err);
            setState({
                error: err instanceof Error ? err : new Error("Failed to apply update"),
                // Don't change subscriptionStatus here, let transport handle eventual disconnect if needed
            });
        }
    };

    const handleSubscriptionError = (errorData: SubscriptionErrorMessage['error']) => {
        if (!isStoreActive) return;
        console.error(`[TypeQL Store] Received subscription error for path "${subscriptionPath}":`, errorData.message);
        const error = new Error(errorData.message || 'Subscription error');
        setState({ error: error, subscriptionStatus: 'error', isLoading: false });
        unsubscribeFn = undefined; // Subscription ended due to error reported by server
    };

    const handleSubscriptionEnd = () => {
        if (!isStoreActive) return;
        console.log(`[TypeQL Store] Received subscription end signal for path "${subscriptionPath}".`);
        setState({ subscriptionStatus: 'ended', error: null, isLoading: false });
        unsubscribeFn = undefined; // Subscription ended gracefully
    };

    // --- Core Logic: Load Initial State and Manage Subscription ---

    const startSubscription = () => {
        if (!isStoreActive || !internalState.isConnected || unsubscribeFn) {
             console.debug(`[TypeQL Store] Skipping subscription start for "${subscriptionPath}" (active: ${isStoreActive}, connected: ${internalState.isConnected}, alreadySubscribed: ${!!unsubscribeFn})`);
             return; // Don't subscribe if disconnected, inactive, or already subscribed
        }

        console.log(`[TypeQL Store] Attempting to subscribe to path "${subscriptionPath}"...`);
        // Don't set loading=true here, only for initial query
        setState({ subscriptionStatus: 'idle', error: null }); // Reset status before trying
        const subscribeId = generateRequestId();
        const subscribeMsg: SubscribeMessage = {
            type: 'subscription',
            id: subscribeId,
            path: subscriptionPath,
            input: subscriptionInput
        };
        const handlers: SubscriptionHandlers = {
            onData: handleSubscriptionData,
            onError: handleSubscriptionError,
            onEnd: handleSubscriptionEnd,
        };

        try {
             // Transport handles actual connection and message sending, including retries/resubscribes
            unsubscribeFn = transport.subscribe(subscribeMsg, handlers);
            // Status becomes 'active' only upon receiving the first data message
        } catch (err: any) {
            console.error(`[TypeQL Store] transport.subscribe failed immediately for path "${subscriptionPath}":`, err);
             // If transport.subscribe throws immediately (unlikely but possible)
             if (isStoreActive) {
                  setState({ error: err instanceof Error ? err : new Error("Failed to initiate subscription"), subscriptionStatus: 'error' });
             }
        }
    };

    const loadInitialAndSubscribe = async () => {
        if (!isStoreActive || !internalState.isConnected) {
             console.debug(`[TypeQL Store] Skipping initial load for "${queryPath}" (active: ${isStoreActive}, connected: ${internalState.isConnected})`);
             setState({ isLoading: false }); // Ensure not stuck in loading if skipped
             return;
        }

        // Prevent concurrent loads
        if (internalState.isLoading) {
            console.debug(`[TypeQL Store] Initial load already in progress for "${queryPath}".`);
            return;
        }

        console.log(`[TypeQL Store] Requesting initial state for path "${queryPath}"...`);
        setState({ isLoading: true, error: null });
        const requestId = generateRequestId();
         const queryMessage: ProcedureCallMessage = {
             type: 'query',
             id: requestId,
             path: queryPath,
             input: queryInput,
         };

         try {
             const resultMessage = await transport.request(queryMessage);
             if (!isStoreActive) return; // Check if disconnected while waiting

             if (resultMessage.result.type === 'data') {
                 const receivedState = resultMessage.result.data as State;
                 console.log(`[TypeQL Store] Initial state received for path "${queryPath}".`);
                 setState({ state: receivedState, isLoading: false, error: null });
                 // Successfully got initial state, now ensure subscription is active
                 startSubscription();
             } else {
                 // Handle procedure error result
                 const error = new Error(resultMessage.result.error.message || 'Failed to fetch initial state (procedure error)');
                 console.error(`[TypeQL Store] Procedure error fetching initial state for path "${queryPath}":`, resultMessage.result.error);
                 setState({ isLoading: false, error: error, state: undefined }); // Clear state on error
             }
         } catch (err: any) {
              // Handle transport error
             console.error(`[TypeQL Store] Transport error fetching initial state for path "${queryPath}":`, err);
              if (isStoreActive) {
                  setState({ isLoading: false, error: err instanceof Error ? err : new Error("Transport error fetching initial state"), state: undefined }); // Clear state on error
              }
        }
     }; // End loadInitialAndSubscribe

     const unsubscribeFromUpdates = () => {
         if (unsubscribeFn) {
             console.log(`[TypeQL Store] Cleaning up subscription for path "${subscriptionPath}"...`);
             try {
                 unsubscribeFn();
             } catch (err) {
                 console.warn(`[TypeQL Store] Error during transport unsubscribe call:`, err);
             }
             unsubscribeFn = undefined;
              // Update status only if the store is still marked active
              if (isStoreActive) {
                 // Reset status to idle, assuming user might want to reconnect/refresh later
                 setState({ subscriptionStatus: 'idle' });
             }
        }
     };

     const handleConnectionChange = (newIsConnected: boolean) => {
         if (!isStoreActive) return;

         console.log(`[TypeQL Store] Connection change detected: ${newIsConnected}`);
         const wasConnected = internalState.isConnected;
         // Update state immediately
         setState({ isConnected: newIsConnected });

         if (newIsConnected && !wasConnected) {
             console.log(`[TypeQL Store] Transport reconnected for path "${subscriptionPath}".`);
             // Option 1: Refresh everything if configured
             if (refreshOnReconnect) {
                 console.log(`[TypeQL Store] Refreshing data due to reconnect (refreshOnReconnect=true).`);
                 loadInitialAndSubscribe(); // Re-fetch initial state and ensure subscription restarts
             }
             // Option 2: Just ensure subscription is active (transport handles resending subscribe message)
             // If not refreshing, we rely on the transport's automatic resubscribe.
             // We might need to call startSubscription() just to ensure the handlers are linked
             // in our state if the unsubscribeFn was cleared previously.
             else if (!unsubscribeFn) {
                  console.log(`[TypeQL Store] Ensuring subscription is active after reconnect.`);
                  startSubscription();
             }
             // If refreshOnReconnect is false AND unsubscribeFn exists, we assume the transport
             // successfully re-established the subscription automatically.

         } else if (!newIsConnected && wasConnected) {
              console.warn(`[TypeQL Store] Transport disconnected for path "${subscriptionPath}". Subscription paused.`);
              // Update status, keep existing state, but mark subscription as potentially inactive
              // The actual unsubscribeFn might still be held by the transport for its internal logic
              setState({ error: new Error("Transport disconnected"), subscriptionStatus: 'idle' });
              // Don't clear unsubscribeFn here, transport manages its lifecycle on disconnect.
         }
     };

     // --- Initialization ---
     if (transport.onConnectionChange) {
         cleanupConnectionListener = transport.onConnectionChange(handleConnectionChange);
     } else {
         console.warn(`[TypeQL Store] Transport for path "${subscriptionPath}" does not provide onConnectionChange. Reconnect behavior might be limited.`);
         // Assume connected if not specified otherwise? Or default to false? Let's use the transport's initial state.
         internalState.isConnected = transport.connected ?? false;
     }

     if (internalState.isConnected) {
         console.log(`[TypeQL Store] Initializing store for path "${subscriptionPath}" (already connected).`);
         loadInitialAndSubscribe(); // Fetch initial state and subscribe
     } else {
         console.warn(`[TypeQL Store] Transport initially disconnected for path "${subscriptionPath}". Waiting for connection.`);
         // State remains as initialized (isLoading: false)
     }
     // --- End Initialization ---

     const storeApi: TypeQLStore<State> = {
         getState: () => Object.freeze({ ...internalState }),
         subscribe: (listener) => {
             listeners.add(listener);
             return () => listeners.delete(listener);
         },
         refresh: () => {
             if (!isStoreActive) {
                 console.warn(`[TypeQL Store] Cannot refresh store for path "${subscriptionPath}" as it has been disconnected.`);
                 return;
             }
             if (!internalState.isConnected) {
                  console.warn(`[TypeQL Store] Cannot refresh store for path "${subscriptionPath}" as transport is disconnected.`);
                  return;
             }
             console.log(`[TypeQL Store] Manual refresh requested for path "${queryPath}".`);
             loadInitialAndSubscribe();
         },
         // connect method removed - rely on transport connection logic + initial load/refresh
         disconnect: () => {
             if (!isStoreActive) return;
             console.log(`[TypeQL Store] Disconnecting store for path "${subscriptionPath}".`);
             isStoreActive = false; // Prevent further updates/actions

             unsubscribeFromUpdates(); // Attempt to clean up transport subscription

             if (cleanupConnectionListener) {
                  cleanupConnectionListener(); // Clean up our connection listener
                  cleanupConnectionListener = undefined;
             }
             listeners.clear(); // Clear state listeners

             // Optionally call transport.disconnect() if store initiated connection?
             // For now, assume transport lifecycle is managed externally or via its own means.
             // transport.disconnect?.();

             // Update state to reflect disconnection
             setState({
                  isLoading: false,
                  error: new Error("Store disconnected by client"),
                  isConnected: false,
                  subscriptionStatus: 'idle' // Or 'ended'? 'idle' seems appropriate.
             });
        },
    };

    return storeApi;
}

console.log("packages/core/src/client/createStore.ts loaded");
