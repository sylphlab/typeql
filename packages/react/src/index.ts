// packages/react/src/index.ts

// packages/react/src/index.ts

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
// Correct import paths using workspace alias
import { createClient, AnyRouter, TypeQLClientError } from '@typeql/core'; // Import AnyRouter type and Error type
// Import necessary types from @typeql/core
import type {
    SubscriptionHandlers,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    TypeQLTransport, // Needed for client type
    ProcedureResultMessage // Needed for query/mutation output
} from '@typeql/core';

// --- Context ---

// Assume createClient returns a structure that includes the transport
// Adjust this based on the actual return type of createClient
type TypeQLClient<TRouter extends AnyRouter> = ReturnType<typeof createClient<TRouter>> & {
    transport: TypeQLTransport; // Ensure transport is accessible if needed
};

// Create the context with a generic type for the router
// Using unknown initially and casting in the hook for better type safety downstream
const TypeQLContext = createContext<TypeQLClient<AnyRouter> | null>(null);

// --- Provider ---

export interface TypeQLProviderProps<TRouter extends AnyRouter> {
  client: TypeQLClient<TRouter>;
  children: React.ReactNode;
}

/**
 * Provider component to make the TypeQL client available via context.
 */
export function TypeQLProvider<TRouter extends AnyRouter>({
    client,
    children,
}: TypeQLProviderProps<TRouter>): React.ReactElement {
    // Use useMemo to ensure the context value reference doesn't change unnecessarily
    const contextValue = useMemo(() => client, [client]);
    return React.createElement(TypeQLContext.Provider, { value: contextValue }, children);
}

// --- Hook ---

/**
 * Hook to access the TypeQL client instance from the context.
 * Throws an error if used outside of a TypeQLProvider.
 */
export function useTypeQLClient<TRouter extends AnyRouter = AnyRouter>(): TypeQLClient<TRouter> {
    const client = useContext(TypeQLContext);
    if (!client) {
        throw new Error('`useTypeQLClient` must be used within a `TypeQLProvider`.');
    }
    // Cast needed as the context is created with `AnyRouter`
    return client as TypeQLClient<TRouter>;
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
export interface UseQueryOptions {
    enabled?: boolean;
    // staleTime?: number; // Placeholder
    // cacheTime?: number; // Placeholder
    // refetchOnWindowFocus?: boolean; // Placeholder
}

// Type for query result state
export interface UseQueryResult<TOutput> {
    data: TOutput | undefined;
    isLoading: boolean;
    isFetching: boolean; // More granular loading state
    isSuccess: boolean;
    isError: boolean;
    error: TypeQLClientError | Error | null;
    status: 'loading' | 'error' | 'success';
    refetch: () => void;
}


/**
 * Hook to perform a TypeQL query.
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
    const client = useTypeQLClient(); // Router type isn't strictly needed if procedure is passed directly
    const [data, setData] = useState<TOutput | undefined>(undefined);
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    // isFetching is true during request, isLoading is true only on initial fetch without data
    const [isFetching, setIsFetching] = useState(enabled);
    const [status, setStatus] = useState<'loading' | 'error' | 'success'>(enabled ? 'loading' : 'success'); // Assume success if not enabled

    const isLoading = isFetching && data === undefined; // Derive isLoading

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

    // Refetch function
    const executeQuery = useCallback(async () => {
        if (!isMountedRef.current) return; // Don't fetch if unmounted

        setIsFetching(true);
        setError(null); // Reset error on new fetch

        try {
            const result = await procedure.query(input);
            if (isMountedRef.current) {
                setData(result as TOutput);
                setStatus('success');
                setError(null);
            }
        } catch (err: any) {
            console.error("useQuery Error:", err);
            if (isMountedRef.current) {
                const errorObj = err instanceof Error ? err : new TypeQLClientError(String(err));
                setError(errorObj);
                setStatus('error');
                // Keep existing data? Or clear it? For now, keep it.
                // setData(undefined);
            }
        } finally {
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
type inferMutationInput<TProcedure> = TProcedure extends { mutate: (input: infer TInput) => any }
    ? TInput
    : never;

type inferMutationOutput<TProcedure> = TProcedure extends { mutate: (...args: any[]) => Promise<infer TOutput> }
    ? TOutput
    : never;

// Type for mutation options
export interface UseMutationOptions<TOutput, TInput> {
    onSuccess?: (data: TOutput, variables: TInput) => void;
    onError?: (error: Error | TypeQLClientError, variables: TInput) => void;
    onMutate?: (variables: TInput) => void | Promise<any>; // For optimistic updates
}

// Type for mutation result state
export interface UseMutationResult<TOutput, TInput> {
    mutate: (input: TInput) => Promise<TOutput>; // Return promise that resolves/rejects
    mutateAsync: (input: TInput) => Promise<TOutput>; // Explicit async version
    isLoading: boolean;
    isSuccess: boolean;
    isError: boolean;
    error: TypeQLClientError | Error | null;
    data: TOutput | undefined;
    status: 'idle' | 'loading' | 'error' | 'success';
    reset: () => void; // Function to reset state
}

/**
 * Hook to perform a TypeQL mutation.
 */
export function useMutation<
    TProcedure extends { mutate: (...args: any[]) => Promise<any> },
    TInput = inferMutationInput<TProcedure>,
    TOutput = inferMutationOutput<TProcedure>
>(
    procedure: TProcedure,
    options?: UseMutationOptions<TOutput, TInput>
): UseMutationResult<TOutput, TInput> {
    const client = useTypeQLClient(); // Client might not be needed if procedure is stable ref
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

    const executeMutation = useCallback(async (input: TInput): Promise<TOutput> => {
        if (!isMountedRef.current) {
            // Handle unmounted case - maybe throw specific error?
            throw new TypeQLClientError("Component unmounted before mutation could complete.");
        }

        setStatus('loading');
        setError(null);
        setData(undefined);

        try {
            // Optimistic update callback
            await optionsRef.current?.onMutate?.(input);

            const result = await procedure.mutate(input);

            if (isMountedRef.current) {
                setData(result as TOutput);
                setStatus('success');
                optionsRef.current?.onSuccess?.(result as TOutput, input);
                return result as TOutput;
            } else {
                 throw new TypeQLClientError("Component unmounted after mutation success but before state update.");
            }
        } catch (err: any) {
             const errorObj = err instanceof Error ? err : new TypeQLClientError(String(err.message || err));
             if (isMountedRef.current) {
                 setError(errorObj);
                 setStatus('error');
                 optionsRef.current?.onError?.(errorObj, input);
             }
             // Re-throw the error so the caller's await Promise rejects
             throw errorObj;
        }
    }, [procedure]); // Dependency on procedure ref

    return {
        mutate: executeMutation, // Provide main function
        mutateAsync: executeMutation, // Explicit async name
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

// Type for subscription handler options passed to the hook
export interface UseSubscriptionHandlers<TOutput> {
    onData: (data: TOutput) => void;
    onError?: (error: Error | TypeQLClientError) => void;
    onEnd?: () => void;
    onStart?: () => void; // Optional: If transport confirms start
}

// Type for subscription options
export interface UseSubscriptionOptions {
    enabled?: boolean;
}

// Type for subscription result state
export interface UseSubscriptionResult {
    status: 'idle' | 'connecting' | 'active' | 'error' | 'ended'; // Refined status
    error: TypeQLClientError | Error | null;
}

/**
 * Hook to subscribe to a TypeQL subscription.
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
    const client = useTypeQLClient();
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

    useEffect(() => {
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
                if (status !== 'active') setStatus('active');
                handlersRef.current.onData(message.data as TOutput); // Call user handler
            },
            onError: (errorData: SubscriptionErrorMessage['error']) => {
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
            }, // Added comma
            onStart: () => { // If transport signals start
                handlersRef.current.onStart?.();
                // Don't necessarily move to 'active' here, wait for first data
                // This confirms the server acknowledged the subscription
                if (status === 'connecting') {
                     // Still connecting technically, but server ack is good
                }
                // console.debug("Subscription started"); // Optional debug log
            } // Added closing brace for onStart method
        }; // Added closing brace for transportHandlers object literal

        try { // Moved try block outside handler definition
            // Call the procedure's subscribe method
            unsubscribeRef.current = procedure.subscribe(input, transportHandlers);
        } catch (err: any) { // Moved catch block outside handler definition
             // Handle immediate errors from calling subscribe (less likely)
             const errorObj = err instanceof Error ? err : new TypeQLClientError(String(err));
             setError(errorObj);
             setStatus('error');
             handlersRef.current.onError?.(errorObj);
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
