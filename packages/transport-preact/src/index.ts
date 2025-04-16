// packages/transport-preact/src/index.ts

import { createContext, h, FunctionalComponent, ComponentChildren } from 'preact';
import { useContext, useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
// Correct import paths using workspace alias
import {
    createClient,
    AnyRouter,
    TypeQLClientError,
    TypeQLTransport,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    ProcedureResultMessage,
    OptimisticStore,
    MutationCallOptions,
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
  children: ComponentChildren; // Use Preact's ComponentChildren
}

/**
 * Provider component to make the TypeQL client and optional store available via context.
 */
export const TypeQLProvider: FunctionalComponent<TypeQLProviderProps<any, any>> = ({ // Use FunctionalComponent
    client,
    store, // Accept store prop
    children,
}) => {
    // Memoize the context value object itself
    const contextValue = useMemo(() => ({
        client,
        store,
    }), [client, store]); // Dependencies include client and store

    // Cast the value to match the context type signature
    // Use h for creating element
    return h(TypeQLContext.Provider, { value: contextValue as TypeQLContextValue<AnyRouter, unknown> }, children);
};


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
 * @template TState The type of the state managed by the optimistic store.
 * @template TOutput The expected output type of the query.
 */
export interface UseQueryOptions<TState = any, TOutput = any> { // Add generics
    /**
     * If false, the query will not execute automatically. Defaults to true.
     */
    enabled?: boolean;
    /**
     * Optional function to select the relevant data from the optimistic store's state.
     * Required if using `useQuery` with an `OptimisticStore` where the query output
     * type (`TOutput`) differs from the store's state type (`TState`).
     * @param state The current optimistic state from the store.
     * @returns The selected data corresponding to the query's expected output.
     */
    select?: (state: TState) => TOutput;
    /**
     * The time in milliseconds after data is considered stale. Defaults to 0 (always stale).
     * If set, the data will only be refetched if it is older than the specified time.
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
 * @param options Optional configuration for the query behavior, including an optional `select` function if using an optimistic store.
 * @returns An object containing the query state (`data`, `isLoading`, `isFetching`, `isSuccess`, `isError`, `error`, `status`) and a `refetch` function.
 */
export function useQuery<
    TProcedure extends { query: (...args: any[]) => Promise<any> },
    TInput = inferQueryInput<TProcedure>,
    TOutput = inferQueryOutput<TProcedure>,
    TState = any // Add TState generic for store compatibility
>(
    procedure: TProcedure,
    input: TInput,
    options?: UseQueryOptions<TState, TOutput> // Use generic options type
): UseQueryResult<TOutput> {
    const { enabled = true, select, staleTime = 0 } = options ?? {}; // Destructure select and staleTime
    // Use the new hook to get client and potentially store, specifying TState
    const { client, store } = useTypeQL<AnyRouter, TState>();
    const [data, setData] = useState<TOutput | undefined>(undefined);
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [isFetching, setIsFetching] = useState(false); // Start as false, set true in executeQuery
    const [status, setStatus] = useState<'loading' | 'error' | 'success'>(enabled ? 'loading' : 'success'); // Initial status depends on enabled
    const lastFetchTimeRef = useRef<number>(0); // Ref to store the timestamp of the last successful fetch

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
    const executeQuery = useCallback(async (forceRefetch = false): Promise<void> => { // Add forceRefetch flag
        if (!isMountedRef.current || !procedure) return; // Don't fetch if unmounted or procedure missing

        // Check staleTime if not forcing refetch
        const now = Date.now();
        if (!forceRefetch && data !== undefined && staleTime > 0 && (now - lastFetchTimeRef.current < staleTime)) {
            console.log(`[useQuery] Data is fresh (staleTime: ${staleTime}ms). Skipping fetch.`);
            // Ensure status is success if we have data and it's fresh
            if (status !== 'success') setStatus('success');
            return; // Don't fetch if data is fresh
        }

        console.log(`[useQuery] ${forceRefetch ? 'Forcing refetch' : 'Fetching data'}...`);
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
                   lastFetchTimeRef.current = Date.now(); // Update last fetch time on success
                }
            }
            // Resolve the promise on success (no value needed)
        } catch (err: any) {
            console.error("[TypeQL Preact] useQuery Error:", err); // Update log prefix
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
    }, [procedure, inputKey, data, staleTime, status]); // Add data, staleTime, status as dependencies

    useEffect(() => {
        if (enabled) {
            // Initial fetch or refetch based on staleTime
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, executeQuery]); // Keep dependencies minimal for initial fetch trigger

    // Subscribe to store updates if a store is provided
    useEffect(() => {
        if (!store || !enabled) return; // Only subscribe if store exists and query is enabled

        // Initial data sync if store has state
        if (status !== 'success' && status !== 'loading') { // Only sync if not already loaded/loading
             try {
                 const currentState = store.getOptimisticState();
                 if (select) {
                     setData(select(currentState));
                 } else {
                     // Warn if store is present but no selector and types might mismatch
                     // Basic check: if state is object and output might be primitive/array, warn.
                     // This is imperfect but better than nothing.
                     if (typeof currentState === 'object' && currentState !== null && (typeof data === 'undefined' || typeof data !== 'object')) {
                          // Preact doesn't have process.env.NODE_ENV by default, skip warning or use alternative
                          // console.warn("[useQuery] OptimisticStore provided without a 'select' function...");
                     }
                     // Explicitly cast through unknown to acknowledge potential type mismatch
                     setData(currentState as unknown as TOutput);
                 }
                 // Optionally update status if we get initial data from store?
                 // setStatus('success'); // Let's avoid this for now, let fetch determine success
             } catch (e) {
                console.error("[useQuery] Error getting/selecting initial optimistic state:", e);
             }
        }

        const listener = (optimisticState: TState) => {
             if (isMountedRef.current) {
                 try {
                     if (select) {
                         setData(select(optimisticState));
                     } else {
                         // Apply same warning logic as initial sync if applicable
                         if (typeof optimisticState === 'object' && optimisticState !== null && (typeof data === 'undefined' || typeof data !== 'object')) {
                             // Skip warning or use alternative
                         }
                          // Explicitly cast through unknown to acknowledge potential type mismatch
                         setData(optimisticState as unknown as TOutput);
                     }
                     // Don't change fetch status here, this is a background update
                 } catch (e) {
                     console.error("[useQuery] Error selecting state from optimistic update:", e);
                     // Optionally set error state?
                 }
            }
        };

        const unsubscribe = store.subscribe(listener);
        console.log("[useQuery] Subscribed to OptimisticStore updates.");

        // Cleanup subscription on unmount or dependency change
        return () => {
            unsubscribe();
            console.log("[useQuery] Unsubscribed from OptimisticStore updates.");
        };
    }, [store, enabled, status, select, data]); // Add select and data to dependencies

    // TODO: Implement refetchOnWindowFocus, cacheTime etc.


    return {
        data,
        isLoading,
        isFetching,
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        status,
        refetch: () => executeQuery(true), // Pass forceRefetch=true to refetch function
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
             console.error("[TypeQL Preact] useMutation Error:", err); // Update log prefix
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

// Helper type to infer the data type from the SubscriptionDataMessage yielded by the iterator
// Note: This assumes the iterator yields SubscriptionDataMessage | SubscriptionErrorMessage
type inferSubscriptionDataType<TProcedure> =
    TProcedure extends { subscribe: (...args: any[]) => { iterator: AsyncIterableIterator<infer TMessage> } }
        ? TMessage extends SubscriptionDataMessage // Check if the yielded type is SubscriptionDataMessage
            ? TMessage['data'] // Extract the 'data' type
            : unknown // Fallback if not SubscriptionDataMessage
        : unknown;

// Helper type to infer the input type from the client's subscribe method
type inferSubscriptionInput<TProcedure> = TProcedure extends { subscribe: (input: infer TInput) => any }
    ? TInput
    : never;


/**
 * Options for configuring the useSubscription hook.
 * Includes callbacks for handling subscription events.
 * @template TOutput The expected data type received from the subscription.
 */
export interface UseSubscriptionOptions<TOutput> {
    /**
     * If false, the subscription will not be established automatically. Defaults to true.
     */
    enabled?: boolean;
    /** Callback for when data is received */
    onData?: (data: TOutput) => void;
    /** Callback for when an error occurs */
    onError?: (error: SubscriptionErrorMessage['error']) => void;
    /** Callback for when the subscription ends normally */
    onEnd?: () => void;
    /** Callback for when the subscription starts (transport confirms) */
    onStart?: () => void;
    /**
     * @placeholder If true, the subscription will automatically attempt to reconnect on error.
     */
    // retry?: boolean;
}

/**
 * Represents the state returned by the useSubscription hook.
 * @template TOutput The expected data type received from the subscription.
 */
export interface UseSubscriptionResult<TOutput> {
    /**
     * The latest data received from the subscription. Null initially or if an error occurs.
     * Note: If using an OptimisticStore, prefer selecting data from the store using `useQuery` or similar.
     */
    data: TOutput | null;
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
    /**
     * Function to manually unsubscribe from the subscription.
     */
    unsubscribe: UnsubscribeFn | null;
}

/**
 * Hook to subscribe to a TypeQL subscription and receive real-time delta updates using Async Iterators.
 *
 * @template TProcedure The type of the TypeQL subscription procedure (e.g., `client.messages.onNewMessage`).
 * @template TInput The inferred input type of the subscription procedure.
 * @template TOutput The inferred output type from the procedure's subscription output schema.
 * @param procedure The TypeQL subscription procedure object (e.g., `client.messages.onNewMessage`).
 * @param input The input arguments for the subscription procedure.
 * @param options Optional configuration including `enabled` flag and event callbacks (`onData`, `onError`, `onEnd`, `onStart`).
 * @returns An object containing the subscription state (`status`, `error`, `data`, `unsubscribe`).
 */
export function useSubscription<
    // Procedure should have a subscribe method returning { iterator, unsubscribe } yielding full messages
    TProcedure extends { subscribe: (input: any) => { iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>, unsubscribe: UnsubscribeFn } },
    TInput = inferSubscriptionInput<TProcedure>,
    // Use the updated helper to infer the data type
    TOutput = inferSubscriptionDataType<TProcedure>
>(
    procedure: TProcedure,
    input: TInput,
    options?: UseSubscriptionOptions<TOutput>
): UseSubscriptionResult<TOutput> {
    const { enabled = true } = options ?? {};
    const { client, store } = useTypeQL(); // Get client and store

    const [status, setStatus] = useState<'idle' | 'connecting' | 'active' | 'error' | 'ended'>(
        enabled ? 'connecting' : 'idle'
    );
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [data, setData] = useState<TOutput | null>(null); // Store latest data locally
    const [unsubscribeFn, setUnsubscribeFn] = useState<UnsubscribeFn | null>(null);

    // Use refs for callbacks to keep effect stable
    const onDataRef = useRef(options?.onData);
    const onErrorRef = useRef(options?.onError);
    const onEndRef = useRef(options?.onEnd);
    const onStartRef = useRef(options?.onStart);

    useEffect(() => {
        onDataRef.current = options?.onData;
        onErrorRef.current = options?.onError;
        onEndRef.current = options?.onEnd;
        onStartRef.current = options?.onStart;
    }, [options?.onData, options?.onError, options?.onEnd, options?.onStart]);

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
        if (!enabled || !procedure) {
            // Clean up subscription if disabled or procedure missing
            unsubscribeFn?.();
            setUnsubscribeFn(null);
            if (status !== 'idle') {
                setStatus('idle');
                setError(null);
                setData(null);
            }
            return;
        }

        let unsub: UnsubscribeFn | null = null;
        // Iterator now yields the full message types
        let iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> | null = null;
        let isCancelled = false; // Flag to prevent processing after cleanup

        const startSubscription = async () => {
            if (!isMountedRef.current || isCancelled) return;

            setStatus('connecting');
            setError(null);
            setData(null);

            try {
                // Start the subscription - client proxy handles path resolution
                const subResult = procedure.subscribe(input);
                unsub = subResult.unsubscribe;
                iterator = subResult.iterator; // No assertion needed, type matches
                if (isMountedRef.current && !isCancelled) {
                    setUnsubscribeFn(() => unsub); // Store the actual unsubscribe function
                } else {
                    // If unmounted or cancelled before setting state, immediately unsubscribe
                    unsub?.();
                    return;
                }

                onStartRef.current?.(); // Notify start

                // Consume the iterator
                for await (const result of iterator) {
                    if (!isMountedRef.current || isCancelled) break; // Stop if component unmounted or cancelled

                    // Iterator now yields SubscriptionDataMessage or SubscriptionErrorMessage
                    if (result.type === 'subscriptionData') {
                        if (status !== 'active') setStatus('active'); // Move to active on first data
                        setError(null); // Clear error on data

                        const dataPayload = result.data as TOutput; // Extract data payload

                        // If store exists, apply the full message
                        if (store) {
                            try {
                                // Pass the complete SubscriptionDataMessage to the store
                                store.applyServerDelta(result);
                                console.debug("[useSubscription] Applied server delta to store:", result.serverSeq);

                                // Call user's onData with the extracted payload
                                onDataRef.current?.(dataPayload);
                                // Update local state with the extracted payload
                                setData(dataPayload);

                            } catch (storeError: any) {
                                 console.error("[useSubscription] Error applying server delta to store:", storeError);
                                 const err = storeError instanceof Error ? storeError : new Error(String(storeError));
                                 if (isMountedRef.current && !isCancelled) {
                                     setError(err);
                                     setStatus('error');
                                     // Pass the original error structure to the callback
                                     onErrorRef.current?.({ message: `Store error: ${err.message || err}` });
                                 }
                                 break; // Stop iteration on store error
                            }
                        } else {
                            // No store, update local state and call handler with extracted payload
                            setData(dataPayload);
                            onDataRef.current?.(dataPayload);
                        }
                    } else if (result.type === 'subscriptionError') {
                        // Handle the error message yielded by the iterator
                        console.error("[useSubscription] Subscription error received:", result.error);
                        if (isMountedRef.current && !isCancelled) {
                            // Create a client-side error object for the hook's state
                            const clientError = new TypeQLClientError(result.error.message, result.error.code);
                            setError(clientError);
                            setStatus('error');
                            // Pass the original error structure from the message to the callback
                            onErrorRef.current?.(result.error);
                        }
                        break; // Stop iteration on error
                    }
                    // Note: The loop naturally ends when the iterator is done (server sends 'end')
                }

                // Iteration finished normally (server sent 'end' or iterator completed)
                if (isMountedRef.current && !isCancelled && status !== 'error') {
                    console.log("[useSubscription] Subscription ended normally.");
                    setStatus('ended');
                    onEndRef.current?.();
                }

            } catch (err: any) {
                if (isMountedRef.current && !isCancelled) {
                    console.error("[TypeQL Preact] useSubscription Error:", err); // Update log prefix
                    const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
                    setError(errorObj);
                    setStatus('error');
                    onErrorRef.current?.({ message: `Subscription failed: ${errorObj.message || errorObj}` });
                }
            } finally {
                 if (isMountedRef.current && !isCancelled && status !== 'ended' && status !== 'error') {
                     // If loop finishes without explicit end/error (e.g., iterator.return called), mark as ended
                     // setStatus('ended'); // Or maybe 'idle'? Let's stick to 'ended' if it was active/connecting
                 }
                 // Ensure loading is false if it finishes in any state other than connecting/active
                 if (isMountedRef.current && !isCancelled && (status === 'connecting' || status === 'active')) {
                     // This case shouldn't ideally happen if loop finishes, but as a safeguard
                     // setStatus('ended'); // Or 'idle'?
                 }
            }
        };

        startSubscription();

        // Effect cleanup function
        return () => {
            isCancelled = true;
            if (unsub) {
                console.log("[useSubscription] Cleaning up subscription.");
                unsub();
            }
            // Attempt to call iterator.return() for graceful async generator cleanup
            if (iterator && typeof iterator.return === 'function') {
                iterator.return().catch(e => console.warn("[useSubscription] Error during iterator cleanup:", e));
            }
            setUnsubscribeFn(null);
             // Reset status only if effect is cleaning up while potentially active/connecting
             if (status === 'active' || status === 'connecting') {
                  setStatus('idle');
             }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [procedure, inputKey, enabled, client, store]); // Add store to dependencies

    return { status, error, data, unsubscribe: unsubscribeFn };
}

console.log("@typeql/preact loaded: Provider, useTypeQLClient, useQuery, useMutation, useSubscription");
