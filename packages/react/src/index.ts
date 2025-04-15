// packages/react/src/index.ts

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
// Correct import paths using workspace alias
import {
    createClient,
    AnyRouter,
    TypeQLClientError,
    TypeQLTransport,
    SubscriptionHandlers,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    ProcedureResultMessage,
    // Import store type correctly
    OptimisticStore,
    // Import mutation call options type
    MutationCallOptions,
    // Import PredictedChange type used within MutationCallOptions
    PredictedChange,
} from '@typeql/core';


// --- Context ---

// Define the shape of the context value
interface TypeQLContextValue<TRouter extends AnyRouter = AnyRouter, TState = any> {
    client: ReturnType<typeof createClient<TRouter>>; // The client proxy
    store?: OptimisticStore<TState>; // Optional optimistic store
}

// Create the context with a more specific type, using unknown for generics initially
const TypeQLContext = createContext<TypeQLContextValue<AnyRouter, unknown> | null>(null);


// --- Provider ---

export interface TypeQLProviderProps<TRouter extends AnyRouter, TState = any> {
  client: ReturnType<typeof createClient<TRouter>>; // Expect the client proxy
  store?: OptimisticStore<TState>; // Optional store
  children: React.ReactNode;
}

/**
 * Provider component to make the TypeQL client and optional store available via context.
 */
export function TypeQLProvider<TRouter extends AnyRouter, TState = any>({
    client,
    store, // Accept store prop
    children,
}: TypeQLProviderProps<TRouter, TState>): React.ReactElement {
    // Memoize the context value object itself
    const contextValue = useMemo(() => ({
        client,
        store,
    }), [client, store]); // Dependencies include client and store

    // Cast the value to match the context type signature
    return React.createElement(TypeQLContext.Provider, { value: contextValue as TypeQLContextValue<AnyRouter, unknown> }, children);
}


// --- Hook ---

/**
 * Hook to access the TypeQL client instance and optional optimistic store from the context.
 * Throws an error if used outside of a TypeQLProvider.
 *
 * @template TRouter The application's root router type.
 * @template TState The type of the state managed by the optimistic store.
 * @returns An object containing the `client` proxy and the optional `store` instance.
 */
export function useTypeQL<TRouter extends AnyRouter = AnyRouter, TState = any>(): TypeQLContextValue<TRouter, TState> {
    // Use the correct context type here
    const context = useContext<TypeQLContextValue<AnyRouter, any> | null>(TypeQLContext);
    if (!context) {
        throw new Error('`useTypeQL` must be used within a `TypeQLProvider`.');
    }
    // Cast needed as the context is created with `AnyRouter` and `unknown` state
    return context as TypeQLContextValue<TRouter, TState>;
}

// --- Deprecated Hook Alias ---
/**
 * @deprecated Use `useTypeQL().client` instead. Accessing only the client might hide the need for the store.
 */
export function useTypeQLClient<TRouter extends AnyRouter = AnyRouter>(): ReturnType<typeof createClient<TRouter>> {
     console.warn("`useTypeQLClient` is deprecated. Use `useTypeQL().client` instead.");
     return useTypeQL<TRouter>().client;
}

// --- Query Hook ---

// Refined Helper types assuming procedure is client.path.to.procedure
type inferQueryInput<TProcedure> = TProcedure extends { query: (input: infer TInput) => any }
    ? TInput
    : never;

// Inferring output from the promise returned by the query function
type inferQueryOutput<TProcedure> = TProcedure extends { query: (...args: any[]) => Promise<infer TOutput> }
    ? TOutput
    : never;

// Type for query options
/**
 * Options for configuring the useQuery hook.
 */
export interface UseQueryOptions {
    /**
     * If false, the query will not execute automatically. Defaults to true.
     */
    enabled?: boolean;
    /**
     * @placeholder The time in milliseconds after data is considered stale.
     * If set, the data will only be refetched if it is stale.
     */
    staleTime?: number;
    /**
     * @placeholder The time in milliseconds that unused/inactive cache data remains in memory.
     */
    cacheTime?: number;
    /**
     * @placeholder If set to true, the query will refetch on window focus.
     */
    refetchOnWindowFocus?: boolean;
    // Add other common query options here as needed (e.g., retries)
}

// Type for query result state
/**
 * Represents the state returned by the useQuery hook.
 * @template TOutput The expected output type of the query.
 */
export interface UseQueryResult<TOutput> {
    /**
     * The data returned by the query. Undefined if the query has not completed or has errored.
     */
    data: TOutput | undefined;
    /**
     * True if the query is currently fetching for the first time and has no data yet.
     */
    isLoading: boolean;
    /**
     * True if the query is currently fetching in the background (e.g., refetching).
     */
    isFetching: boolean;
    /**
     * True if the query completed successfully and data is available.
     */
    isSuccess: boolean;
    /**
     * True if the query encountered an error.
     */
    isError: boolean;
    /**
     * The error object if the query failed, otherwise null. Can be a TypeQLClientError or a generic Error.
     */
    error: TypeQLClientError | Error | null;
    /**
     * The current status of the query: 'loading', 'error', or 'success'.
     * Note: 'loading' implies the initial fetch without data. Use `isFetching` for background fetches.
     */
    status: 'loading' | 'error' | 'success';
    /**
     * Function to manually trigger a refetch of the query.
     */
    refetch: () => Promise<void>; // Return promise for better async handling
}


/**
 * Hook to perform a TypeQL query.
 * Automatically fetches data based on the procedure and input.
 * Manages loading, error, and data states.
 *
 * @template TProcedure The type of the TypeQL procedure (e.g., `client.users.get`).
 * @template TInput The inferred input type of the query procedure.
 * @template TOutput The inferred output type of the query procedure.
 * @param procedure The TypeQL query procedure object (e.g., `client.users.get`).
 * @param input The input arguments for the query procedure.
 * @param options Optional configuration for the query behavior.
 * @returns An object containing the query state (`data`, `isLoading`, `isFetching`, `isSuccess`, `isError`, `error`, `status`) and a `refetch` function.
 */
export function useQuery<
    TProcedure extends { query: (...args: any[]) => Promise<any> }, // Expect procedure to have a query method
    TInput = inferQueryInput<TProcedure>,
    TOutput = inferQueryOutput<TProcedure>
>(
    procedure: TProcedure,
    input: TInput,
    options?: UseQueryOptions
): UseQueryResult<TOutput> {
    const { enabled = true } = options ?? {};
    // Use the new hook to get client and potentially store
    const { client, store } = useTypeQL();
    // TODO: Connect query hook to optimistic store state? Should reflect optimisticState.
    //       Need to subscribe to store updates.
    const [data, setData] = useState<TOutput | undefined>(undefined);
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [isFetching, setIsFetching] = useState(false); // Start as false, set true in executeQuery
    const [status, setStatus] = useState<'loading' | 'error' | 'success'>(enabled ? 'loading' : 'success'); // Initial status depends on enabled

    const isLoading = status === 'loading' && !data; // More direct derivation

    // Use ref to manage mounted state and prevent state updates after unmount
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    // Serialize input for dependency array - basic JSON stringify, acknowledge limitations
    // Consider libraries like 'fast-json-stable-stringify' or deep comparison for complex inputs
    const inputKey = useMemo(() => {
        try {
            // Use a stable stringifier if available, otherwise fallback
            return JSON.stringify(input);
        } catch {
            console.warn("useQuery: Failed to stringify input for dependency key. Updates may be missed for complex objects.");
            return String(input); // Basic fallback
        }
    }, [input]);

    // Refetch function - now returns promise
    const executeQuery = useCallback(async (): Promise<void> => { // Return promise
        if (!isMountedRef.current || !procedure) return; // Don't fetch if unmounted or procedure missing

        setIsFetching(true);
        // Set status to 'loading' only if there's no data yet
        if (!data) {
            setStatus('loading');
        }
        setError(null); // Reset error on new fetch

        try {
            // Assume procedure.query exists and handles input serialization/passing correctly
            const result = await procedure.query(input); // Direct call
            if (isMountedRef.current) {
                setData(result as TOutput); // Assume result is TOutput
                // Check if still mounted before setting state
                if (isMountedRef.current) {
                   setStatus('success');
                   setError(null);
                }
            }
            // Resolve the promise on success (no value needed)
        } catch (err: any) {
            console.error("[TypeQL React] useQuery Error:", err);
             const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
             // Check if still mounted before setting state
             if (isMountedRef.current) {
                 setError(errorObj);
                 setStatus('error');
                 // Keep existing data on error, consistent with React Query
             }
             // Reject the promise on error
             throw errorObj; // Rethrow so await caller gets the error
        } finally {
             // Check if still mounted before setting state
             if (isMountedRef.current) {
                setIsFetching(false);
            }
        }
    }, [procedure, inputKey]); // inputKey represents stable input

    useEffect(() => {
        if (enabled) {
            executeQuery();
        } else {
            // Reset state if disabled
            if (isFetching || data !== undefined || error !== null) {
                setData(undefined);
                setIsFetching(false);
                setStatus('success'); // If disabled, treat as success with no data/error
                setError(null);
            }
        }
    }, [enabled, executeQuery, isFetching, data, error]); // Include state vars that trigger reset

    // Subscribe to store updates if a store is provided
    useEffect(() => {
        if (!store || !enabled) return; // Only subscribe if store exists and query is enabled

        // Initial data sync if store has state
        // This assumes the store state (TState) is compatible with query output (TOutput)
        // or that the relevant part can be selected. For now, direct cast.
        // Only set initial data from store if query hasn't fetched yet or failed
        if (status !== 'success' && status !== 'loading') {
             try {
                setData(store.getOptimisticState() as TOutput);
                // Optionally update status if we get initial data from store?
                // setStatus('success'); // Maybe? Needs careful thought.
             } catch (e) {
                console.error("[useQuery] Error getting initial optimistic state:", e);
             }
        }


        const listener = (optimisticState: any /* TState */) => {
             if (isMountedRef.current) {
                // TODO: Refine state selection. Assuming optimisticState IS TOutput for now.
                setData(optimisticState as TOutput);
                // Don't change fetch status here, this is a background update
            }
        };

        const unsubscribe = store.subscribe(listener);
        console.log("[useQuery] Subscribed to OptimisticStore updates.");

        // Cleanup subscription on unmount or dependency change
        return () => {
            unsubscribe();
            console.log("[useQuery] Unsubscribed from OptimisticStore updates.");
        };
    }, [store, enabled, status]); // Re-subscribe if store or enabled status changes

    // TODO: Implement refetchOnWindowFocus, staleTime etc.


    return {
        data,
        isLoading,
        isFetching,
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        status,
        refetch: executeQuery,
    };
}

// --- Mutation Hook ---

// Refined Helper types for mutation
// Infer TInput from the `input` property of the options object expected by procedure.mutate
type inferMutationInput<TProcedure> = TProcedure extends { mutate: (opts: { input: infer TIn }) => any }
    ? TIn
    : never;

type inferMutationOutput<TProcedure> = TProcedure extends { mutate: (...args: any[]) => Promise<infer TOutput> }
    ? TOutput
    : never;

/**
 * Options for configuring the useMutation hook.
 * @template TOutput The expected output type of the mutation.
 * @template TInput The input type of the mutation.
 * @template TState The state type used by the optimistic store.
 */
export interface UseMutationOptions<TOutput, TInput, TState = any> {
     /**
      * Provides the predicted change for an optimistic update.
      * If provided alongside an OptimisticStore in context, the mutation will be applied optimistically.
      */
     optimistic?: {
        predictedChange: PredictedChange<TState>;
     };
    /**
     * Callback function fired when the mutation is successful.
     * @param data The data returned by the mutation.
     * @param variables The input variables the mutation was called with.
     */
    onSuccess?: (data: TOutput, variables: TInput) => Promise<void> | void;
    /**
     * Callback function fired when the mutation encounters an error.
     * @param error The error object (TypeQLClientError or generic Error).
     * @param variables The input variables the mutation was called with.
     */
    onError?: (error: TypeQLClientError | Error, variables: TInput) => Promise<void> | void;
    /**
     * Callback function fired before the mutation function is fired.
     * Useful for optimistic updates. It receives the variables the mutation will be called with.
     * If it returns a promise, that promise will be awaited before the mutation fires.
     * It can optionally return a context value that will be passed to onError or onSettled.
     * @placeholder Currently does not support context passing like React Query.
     * @param variables The input variables the mutation will be called with.
     */
    onMutate?: (variables: TInput) => Promise<any> | void;
    /**
     * @placeholder Callback function fired when the mutation is finished (either successfully or with an error).
     * @param data The data returned by the mutation (if successful).
     * @param error The error object (if mutation failed).
     * @param variables The input variables the mutation was called with.
     * @param context The context value returned from onMutate (if used).
     */
    // onSettled?: (data: TOutput | undefined, error: TypeQLClientError | Error | null, variables: TInput, context?: any) => Promise<void> | void;
    /**
     * @placeholder Number of times the mutation will automatically retry on failure. Defaults to 0.
     */
    // retry?: number;
}

/**
 * Represents the state and functions returned by the useMutation hook.
 * @template TOutput The expected output type of the mutation.
 * @template TInput The input type of the mutation.
 * @template TState The state type used by the optimistic store.
 */
export interface UseMutationResult<TOutput, TInput, TState = any> {
    /**
     * Function to trigger the mutation. Pass the input variables.
     * If optimistic options were provided to `useMutation`, they will be used internally.
     * Returns a Promise that resolves with the mutation result on success or rejects with an error on failure.
     */
    mutate: (input: TInput) => Promise<TOutput>;
    /**
     * Same as `mutate`, but explicitly named for async/await usage clarity.
     */
    mutateAsync: (input: TInput) => Promise<TOutput>;
    /**
     * True if the mutation is currently executing.
     */
    isLoading: boolean;
    /**
     * True if the mutation completed successfully.
     */
    isSuccess: boolean;
    /**
     * True if the mutation encountered an error.
     */
    isError: boolean;
    /**
     * The error object if the mutation failed, otherwise null.
     */
    error: TypeQLClientError | Error | null;
    /**
     * The data returned by the last successful mutation execution. Undefined otherwise.
     */
    data: TOutput | undefined;
    /**
     * The current status of the mutation: 'idle', 'loading', 'error', or 'success'.
     */
    status: 'idle' | 'loading' | 'error' | 'success';
    /**
     * Function to reset the mutation state back to 'idle', clearing any data or error.
     */
    reset: () => void;
}

/**
 * Hook to perform a TypeQL mutation.
 * Provides functions to trigger the mutation and tracks its state (loading, success, error, data).
 * Supports optimistic updates if an OptimisticStore is provided via context and optimistic options are configured.
 *
 * @template TProcedure The type of the TypeQL procedure (e.g., `client.users.create`). Needs a `mutate` method expecting `MutationCallOptions`.
 * @template TInput The inferred input type of the mutation procedure.
 * @template TOutput The inferred output type of the mutation procedure.
 * @template TState The state type managed by the optimistic store.
 * @param procedure The TypeQL mutation procedure object (e.g., `client.users.create`).
 * @param options Optional configuration for the mutation behavior, callbacks, and optimistic updates.
 * @returns An object containing the mutation state (`isLoading`, `isSuccess`, `isError`, `error`, `data`, `status`) and functions (`mutate`, `mutateAsync`, `reset`).
 */
export function useMutation<
    // Ensure the procedure's mutate expects MutationCallOptions
    TProcedure extends { mutate: (opts: MutationCallOptions<any, any>) => Promise<any> },
    // Infer TInput from the 'input' property of the options expected by procedure.mutate
    TInputArgs = Parameters<TProcedure['mutate']>[0], // Get the options object type { input: TIn, optimistic?: ... }
    TInput = TInputArgs extends MutationCallOptions<infer In, any> ? In : never, // Extract TInput
    TOutput = Awaited<ReturnType<TProcedure['mutate']>>, // Infer output from the promise
    TState = any // Add state generic for store
>(
    procedure: TProcedure,
    options?: UseMutationOptions<TOutput, TInput, TState> // Hook options include TState
): UseMutationResult<TOutput, TInput, TState> { // Add TState to result type
    // Use the hook that provides both client and store
    const { client, store } = useTypeQL<AnyRouter, TState>(); // Get store instance
    const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'success'>('idle');
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [data, setData] = useState<TOutput | undefined>(undefined);

    // Use ref for options to keep callback stable
    const optionsRef = useRef(options);
    useEffect(() => {
        optionsRef.current = options;
    }, [options]);

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const reset = useCallback(() => {
        if (isMountedRef.current) {
            setStatus('idle');
            setError(null);
            setData(undefined);
        }
    }, []);

    // The internal execution function, accepts the raw input
    const executeMutationInternal = useCallback(async (input: TInput): Promise<TOutput> => {
         if (!isMountedRef.current) {
             throw new TypeQLClientError("Component unmounted before mutation could complete.");
        }

        setStatus('loading');
        setError(null);
        setData(undefined);

        try {
            // --- Prepare optimistic options from the hook's configuration ---
            let optimisticArg: MutationCallOptions<TInput, TState>['optimistic'] | undefined;
            // Check for store and optimistic config in hook options
            if (store && optionsRef.current?.optimistic && optionsRef.current.optimistic.predictedChange) {
                optimisticArg = {
                     predictedChange: optionsRef.current.optimistic.predictedChange,
                 };
                 console.log("[useMutation] Preparing optimistic update arguments.");
            }
            // --- End Prepare optimistic options ---

            // Call the hook's onMutate callback *before* the procedure call
            await optionsRef.current?.onMutate?.(input);

            // Prepare the arguments for the client proxy's mutate method
            const mutationArgs: MutationCallOptions<TInput, TState> = {
                input,
                ...(optimisticArg && { optimistic: optimisticArg }) // Conditionally add optimistic part
            };

            // Pass the mutationArgs (containing input and potentially optimistic) to the client proxy's mutate method
            // Assume `procedure.mutate` is the actual method on the client proxy
            const result = await procedure.mutate(mutationArgs);

            if (isMountedRef.current) {
                setData(result as TOutput);
                setStatus('success');
                optionsRef.current?.onSuccess?.(result as TOutput, input);
                return result as TOutput;
            } else {
                 throw new TypeQLClientError("Component unmounted after mutation success but before state update.");
            }
        } catch (err: any) {
             console.error("[TypeQL React] useMutation Error:", err); // Add specific logging
             // Consistent error handling like useQuery
             const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
             if (isMountedRef.current) {
                 setError(errorObj);
                 setStatus('error');
                 optionsRef.current?.onError?.(errorObj, input);
             }
             // Re-throw the error so the caller's await Promise rejects
             throw errorObj;
        }
    }, [procedure, store]); // Dependencies: procedure ref and store instance

    // The function returned to the user, accepts raw input
    const triggerMutation = useCallback((input: TInput) => {
        return executeMutationInternal(input);
    }, [executeMutationInternal]);


    return {
        mutate: triggerMutation, // Provide main function
        mutateAsync: triggerMutation, // Explicit async name
        isLoading: status === 'loading',
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        data,
        status,
        reset,
    };
}

// --- Subscription Hook ---

// Refined Helper types for subscription
type inferSubscriptionInput<TProcedure> = TProcedure extends { subscribe: (input: infer TInput, handlers: any) => any }
    ? TInput
    : never;

// Infer output type from the onData handler provided by the user
type inferSubscriptionOutput<THandlers extends UseSubscriptionHandlers<any>> =
    THandlers extends UseSubscriptionHandlers<infer TOutput> ? TOutput : unknown;

/**
 * Handlers for processing subscription events.
 * @template TOutput The expected data type received from the subscription.
 */
export interface UseSubscriptionHandlers<TOutput> {
    /**
     * Callback function fired when new data is received from the subscription.
     * @param data The data payload.
     */
    onData: (data: TOutput) => void;
    /**
     * Callback function fired when the subscription encounters an error.
     * @param error The error object.
     */
    onError?: (error: TypeQLClientError | Error) => void;
    /**
     * Callback function fired when the subscription ends gracefully (e.g., server signals completion).
     */
    onEnd?: () => void;
    /**
     * Callback function fired when the transport layer confirms the subscription has started on the server.
     * Note: This does not guarantee data has been received yet.
     */
    onStart?: () => void;
}

/**
 * Options for configuring the useSubscription hook.
 */
export interface UseSubscriptionOptions {
    /**
     * If false, the subscription will not be established automatically. Defaults to true.
     */
    enabled?: boolean;
    /**
     * @placeholder If true, the subscription will automatically attempt to reconnect on error.
     */
    // retry?: boolean;
}

/**
 * Represents the state returned by the useSubscription hook.
 */
export interface UseSubscriptionResult {
    /**
     * The current status of the subscription:
     * - 'idle': Not active or attempting to connect (usually when `enabled` is false).
     * - 'connecting': Attempting to establish the WebSocket connection or send the initial subscribe message.
     * - 'active': Subscription is established and receiving data (or waiting for data after `onStart`).
     * - 'error': An error occurred.
     * - 'ended': The subscription ended gracefully.
     */
    status: 'idle' | 'connecting' | 'active' | 'error' | 'ended';
    /**
     * The error object if the subscription failed or encountered an error during its lifecycle, otherwise null.
     */
    error: TypeQLClientError | Error | null;
}

/**
 * Hook to subscribe to a TypeQL subscription and receive real-time delta updates.
 *
 * @template TProcedure The type of the TypeQL subscription procedure (e.g., `client.messages.onNewMessage`).
 * @template THandlers The type of the handlers object provided, used to infer TOutput.
 * @template TInput The inferred input type of the subscription procedure.
 * @template TOutput The inferred output type from the `onData` handler.
 * @param procedure The TypeQL subscription procedure object (e.g., `client.messages.onNewMessage`).
 * @param input The input arguments for the subscription procedure.
 * @param handlers An object containing callback functions (`onData`, `onError`, `onEnd`, `onStart`) to handle subscription events. `onData` is required.
 * @param options Optional configuration for the subscription behavior.
 * @returns An object containing the subscription state (`status`, `error`). The actual data is handled via the `onData` callback.
 */
export function useSubscription<
    TProcedure extends { subscribe: (...args: any[]) => UnsubscribeFn },
    THandlers extends UseSubscriptionHandlers<any>, // THandlers is now mandatory and comes earlier
    TInput = inferSubscriptionInput<TProcedure>, // TInput can default or be inferred
    TOutput = inferSubscriptionOutput<THandlers> // TOutput inferred from THandlers
>(
    procedure: TProcedure,
    input: TInput,
    handlers: THandlers,
    options?: UseSubscriptionOptions
): UseSubscriptionResult {
    const { enabled = true } = options ?? {};
    const { client, store } = useTypeQL(); // Get client and store
    // TODO: Connect subscription hook to optimistic store state? Should reflect optimisticState.
    //       Need to subscribe to store updates.
    // Refined status: connecting indicates transport might be connecting or initial subscribe sent
    const [status, setStatus] = useState<'idle' | 'connecting' | 'active' | 'error' | 'ended'>(
        enabled ? 'connecting' : 'idle'
    );
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);

    // Use ref for handlers to prevent effect re-runs if handler identity changes
    const handlersRef = useRef(handlers);
    useEffect(() => {
        handlersRef.current = handlers;
    }, [handlers]);

    // Use ref for the unsubscribe function
    const unsubscribeRef = useRef<UnsubscribeFn | null>(null);

    // Serialize input for dependency array
    const inputKey = useMemo(() => {
        try {
            return JSON.stringify(input);
        } catch {
            console.warn("useSubscription: Failed to stringify input for dependency key. Updates may be missed for complex objects.");
            return String(input); // Basic fallback
        }
    }, [input]);

    // Ref to track mounted state
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);


    useEffect(() => { // Main subscription effect
        if (!enabled) {
            // Clean up subscription if disabled
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
            // Reset status only if it wasn't already idle
            if (status !== 'idle') {
                setStatus('idle');
                setError(null);
            }
            return;
        }

        // Reset state before subscribing
        setStatus('connecting'); // Indicate attempt to subscribe/connect
        setError(null);

        // Create the handlers expected by the core transport subscribe method
        const transportHandlers: SubscriptionHandlers = {
            onData: (message: SubscriptionDataMessage) => {
                // Move to active on first data
                 if (status !== 'active' && isMountedRef.current) setStatus('active');

                // If store exists, pass the full message (with sequence numbers) to it
                if (store) {
                    try {
                        store.applyServerDelta(message);
                        // Note: User's onData is NOT called directly if store handles it.
                        // The store's notification mechanism should trigger updates in useQuery/other hooks.
                    } catch (storeError: any) {
                        console.error("[useSubscription] Error calling store.applyServerDelta:", storeError);
                        // Optionally propagate this error? For now, just log it.
                         if (isMountedRef.current) {
                             // Use the onError handler provided by the user if available
                             const errorObj = new TypeQLClientError(`Store delta application failed: ${storeError.message || storeError}`);
                             handlersRef.current.onError?.(errorObj);
                             // Potentially set status to 'error'
                             // setStatus('error'); setError(errorObj);
                         }
                    }
                } else {
                    // If no store, call the user's handler directly with the data payload
                    handlersRef.current.onData(message.data as TOutput);
                }
            },
            onError: (errorData: SubscriptionErrorMessage['error']) => {
                 if (!isMountedRef.current) return; // Avoid state updates if unmounted
                const errorObj = new TypeQLClientError(errorData.message || 'Subscription error', errorData.code);
                setError(errorObj);
                setStatus('error');
                handlersRef.current.onError?.(errorObj);
                unsubscribeRef.current = null; // Subscription is terminated
            },
            onEnd: () => {
                setStatus('ended');
                handlersRef.current.onEnd?.();
                unsubscribeRef.current = null; // Subscription is terminated
            },
            onStart: () => { // If transport signals start
                handlersRef.current.onStart?.();
                // Don't necessarily move to 'active' here, wait for first data
                // This confirms the server acknowledged the subscription
                if (status === 'connecting') {
                     // Still connecting technically, but server ack is good
                }
                // console.debug("Subscription started"); // Optional debug log
            }
        };

        try {
            // Call the procedure's subscribe method (assuming procedure is the client proxy method)
            // @ts-ignore - Bypassing type check, client proxy structure needs refinement
            unsubscribeRef.current = procedure.subscribe(input, transportHandlers);
        } catch (err: any) { // Catch immediate errors from calling subscribe
             console.error("[TypeQL React] useSubscription immediate subscribe error:", err); // Add specific logging
             // Consistent error handling like useQuery
             const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
             // Ensure state update happens only if mounted, using the isMountedRef defined above
             if (isMountedRef.current) { // Check if mounted before setting state
                 setError(errorObj);
                 setStatus('error');
                 handlersRef.current.onError?.(errorObj); // Call handler only if mounted? Decided yes.
             }
             unsubscribeRef.current = null;
        }

        // Effect cleanup function
        return () => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
             // Reset status only if effect is cleaning up while potentially active/connecting
             // Don't reset if already 'error' or 'ended' by handlers
             if (status === 'active' || status === 'connecting') {
                  setStatus('idle');
             }
        };

    }, [procedure, inputKey, enabled, client]); // client dependency needed? Maybe not if procedure is stable.

    return { status, error };
}

console.log("@typeql/react loaded: Provider, useTypeQLClient, useQuery, useMutation, useSubscription");
