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
    /** Subscription status. */
    subscriptionStatus: 'idle' | 'subscribing' | 'subscribed' | 'error' | 'ended';
    /** Is the transport currently considered connected? */
    isConnected: boolean;
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
    /** Optional: Callback for connection status changes. */
    onConnectionChange?: (isConnected: boolean) => void;
}

/** Public API of the basic TypeQL Store. */
export interface TypeQLStore<State> {
    /** Get the current state of the store. */
    getState: () => Readonly<StoreState<State>>;
    /** Subscribe to state changes. */
    subscribe: (listener: (state: Readonly<StoreState<State>>) => void) => () => void;
    /** Force a refresh by re-requesting the initial state. */
    refresh: () => void;
    /** Connect or reconnect the store's subscription. */
    connect: () => void;
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
        onConnectionChange: userOnConnectionChange,
    } = options;

    let internalState: StoreState<State> = {
        state: initialState,
        isLoading: false,
        error: null,
        subscriptionStatus: 'idle',
        isConnected: transport.connected ?? true, // Initialize based on transport
    };

    const listeners = new Set<(state: Readonly<StoreState<State>>) => void>();
    let unsubscribeFn: UnsubscribeFn | undefined;
    let cleanupConnectionListener: (() => void) | void | undefined;
    let isStoreActive = true; // Flag to prevent actions after disconnect

    // --- State Management ---
    const setState = (newState: Partial<StoreState<State>>) => {
        internalState = { ...internalState, ...newState };
        // Prevent listeners from being called after disconnect
        if (isStoreActive) {
            listeners.forEach(listener => listener(Object.freeze({ ...internalState })));
        }
    };

    // --- Subscription Handlers ---
    const handleSubscriptionData = (message: SubscriptionDataMessage) => {
        if (!isStoreActive) return;
        try {
            const newState = applyUpdate(internalState.state, message.data as SubscriptionOutput);
            setState({
                state: newState,
                error: null,
                isLoading: false, // No longer loading once data arrives
                subscriptionStatus: 'subscribed' // Mark as subscribed on first data
            });
        } catch (err: any) {
            console.error(`[TypeQL Store] Error applying subscription update for path "${subscriptionPath}":`, err);
            setState({ error: err instanceof Error ? err : new Error("Failed to apply update"), subscriptionStatus: 'error' });
        }
    };

    const handleSubscriptionError = (error: SubscriptionErrorMessage['error']) => {
        if (!isStoreActive) return;
        console.error(`[TypeQL Store] Subscription error for path "${subscriptionPath}":`, error.message);
        setState({ error: new Error(error.message || 'Subscription error'), subscriptionStatus: 'error' });
        unsubscribeFn = undefined; // Subscription ended due to error
    };

    const handleSubscriptionEnd = () => {
        if (!isStoreActive) return;
        console.log(`[TypeQL Store] Subscription ended normally for path "${subscriptionPath}".`);
        setState({ subscriptionStatus: 'ended', error: null }); // Clear error on normal end
        unsubscribeFn = undefined;
    };

    // --- Core Logic ---
    const requestInitialState = async () => {
        if (!isStoreActive || !internalState.isConnected) return;

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
                 // Apply update function even for initial state for consistency? Or just set? Let's just set.
                 // If applyUpdate should process initial state, the API needs clarification.
                setState({ state: receivedState, isLoading: false, error: null });
                console.log(`[TypeQL Store] Initial state received for path "${queryPath}".`);
                 // If subscription wasn't active, try subscribing now
                 if (internalState.subscriptionStatus === 'idle' || internalState.subscriptionStatus === 'ended') {
                    subscribeToUpdates();
                }
            } else {
                throw new Error(resultMessage.result.error.message || 'Failed to fetch initial state');
            }
        } catch (err: any) {
            console.error(`[TypeQL Store] Error fetching initial state for path "${queryPath}":`, err);
             if (isStoreActive) {
                 setState({ isLoading: false, error: err instanceof Error ? err : new Error("Failed to fetch initial state"), state: undefined });
             }
        }
    };

    const subscribeToUpdates = () => {
        if (!isStoreActive || !internalState.isConnected || unsubscribeFn || internalState.subscriptionStatus === 'subscribing') return;

        console.log(`[TypeQL Store] Subscribing to path "${subscriptionPath}"...`);
        setState({ subscriptionStatus: 'subscribing', error: null });
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
            unsubscribeFn = transport.subscribe(subscribeMsg, handlers);
            // Don't set to 'subscribed' here, wait for first data message in onData
        } catch (err: any) {
            console.error(`[TypeQL Store] Error initiating subscription for path "${subscriptionPath}":`, err);
            if (isStoreActive) {
                 setState({ isLoading: false, error: err instanceof Error ? err : new Error("Failed to subscribe"), subscriptionStatus: 'error' });
            }
        }
    };

    const unsubscribeFromUpdates = () => {
        if (unsubscribeFn) {
            console.log(`[TypeQL Store] Unsubscribing from path "${subscriptionPath}"...`);
            try {
                unsubscribeFn();
            } catch (err) {
                console.warn(`[TypeQL Store] Error during unsubscribe call:`, err);
            }
            unsubscribeFn = undefined;
             // Only update status if the store hasn't been fully disconnected
             if (isStoreActive) {
                 setState({ subscriptionStatus: 'idle' }); // Or 'ended'? 'idle' seems better if manual disconnect.
             }
        }
    };

    const handleConnectionChange = (newIsConnected: boolean) => {
        if (!isStoreActive) return;
        internalState.isConnected = newIsConnected; // Update internal tracker first
        setState({ isConnected: newIsConnected });
        userOnConnectionChange?.(newIsConnected);

        if (newIsConnected) {
            console.log(`[TypeQL Store] Reconnected. Refreshing state and subscription for "${subscriptionPath}"...`);
             // Attempt to refresh initial state and re-subscribe
             requestInitialState(); // This will trigger subscribeToUpdates on success
        } else {
             console.warn(`[TypeQL Store] Disconnected. Subscription for "${subscriptionPath}" paused.`);
             // Clear subscription status, keep state as is
             setState({ subscriptionStatus: 'idle', error: new Error("Transport disconnected") });
             unsubscribeFn = undefined; // Assume transport handled actual unsubscribe/cleanup
        }
    };

    // --- Initialization ---
    if (transport.onConnectionChange) {
        cleanupConnectionListener = transport.onConnectionChange(handleConnectionChange);
    }
    if (internalState.isConnected) {
        requestInitialState(); // Fetch initial state
        // subscribeToUpdates(); // requestInitialState will trigger this on success
    } else {
        console.warn(`[TypeQL Store] Transport initially disconnected for path "${subscriptionPath}". Waiting for connection.`);
        setState({ isLoading: false }); // Not loading if not connected
    }
    // --- End Initialization ---

    const storeApi: TypeQLStore<State> = {
        getState: () => Object.freeze({ ...internalState }),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refresh: () => {
            if (isStoreActive && internalState.isConnected) {
                requestInitialState();
            } else {
                console.warn(`[TypeQL Store] Cannot refresh store for path "${subscriptionPath}" as it is disconnected.`);
            }
        },
        connect: () => {
             if (!isStoreActive) {
                 console.warn(`[TypeQL Store] Cannot connect a store that has been disconnected.`);
                 return;
             }
             if (!internalState.isConnected) {
                 console.log(`[TypeQL Store] Attempting to manually connect/reconnect for path "${subscriptionPath}"...`);
                 // Try to fetch initial state, which should trigger subscription if successful
                 requestInitialState();
                 // If transport has explicit connect method, call it? Depends on transport design.
                 // transport.connect?.();
             }
        },
        disconnect: () => {
            if (!isStoreActive) return;
            console.log(`[TypeQL Store] Disconnecting store for path "${subscriptionPath}".`);
            isStoreActive = false;
            unsubscribeFromUpdates();
            if (cleanupConnectionListener) cleanupConnectionListener();
            listeners.clear();
            // Keep last state but mark as disconnected and errored
            setState({
                 isLoading: false,
                 error: new Error("Store disconnected by client"),
                 isConnected: false,
                 subscriptionStatus: 'idle'
            });
        },
    };

    return storeApi;
}

console.log("packages/core/src/client/createStore.ts loaded");
