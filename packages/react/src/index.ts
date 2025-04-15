// packages/react/src/index.ts

// packages/react/src/index.ts

import React, { createContext, useContext, useMemo } from 'react';
// Correct import paths using workspace alias
import { createClient, AnyRouter } from '@typeql/core'; // Import AnyRouter type as well
// Import necessary types from @typeql/core for subscription hook
import type { SubscriptionHandlers, UnsubscribeFn, SubscriptionDataMessage } from '@typeql/core';

// --- Context ---

// Define a more specific type for the client instance based on createClient's return type
// Assuming createClient returns a specific type `TypeQLClientProxy<TRouter>`
type TypeQLClient<TRouter extends AnyRouter> = ReturnType<typeof createClient<TRouter>>;

// Create the context with a generic type for the router
const TypeQLContext = createContext<TypeQLClient<any> | null>(null);

// --- Provider ---

export interface TypeQLProviderProps<TRouter extends AnyRouter> {
  client: TypeQLClient<TRouter>;
  children: React.ReactNode;
}

/**
 * Provider component to make the TypeQL client available via context.
 */
// Removed export keyword
function TypeQLProvider<TRouter extends AnyRouter>({
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
// Removed export keyword
function useTypeQLClient<TRouter extends AnyRouter>(): TypeQLClient<TRouter> {
  const client = useContext(TypeQLContext);
  if (!client) {
    throw new Error('`useTypeQLClient` must be used within a `TypeQLProvider`.');
  }
  // Cast needed as the context is created with `any` router type initially.
  return client as TypeQLClient<TRouter>;
}

// --- Query Hook (Basic Implementation) ---

// Helper type to extract query procedures
// This is complex and might need refinement based on actual client proxy type structure
type inferQueryInput<TProcedure> = TProcedure extends { query: (input: infer TInput) => any } ? TInput : never;
type inferQueryOutput<TProcedure> = TProcedure extends { query: (input: any) => Promise<infer TOutput> } ? TOutput : never;

/**
 * Basic hook to perform a TypeQL query.
 * NOTE: Path resolution and dependency management need significant refinement.
 */
// Removed export keyword
function useQuery<
    TRouter extends AnyRouter,
    TPath extends string, // Placeholder for path inference/validation
    TProcedure extends /* Lookup procedure type based on path */ any,
    TInput = inferQueryInput<TProcedure>,
    TOutput = inferQueryOutput<TProcedure>
>(
    // path: string[], // Replace string array with a more typesafe path lookup/proxy interaction
    procedure: TProcedure, // Pass the actual procedure accessor from the client proxy
    input: TInput,
    options?: { enabled?: boolean }
): { data: TOutput | undefined; isLoading: boolean; error: Error | null } {
    // Get client instance via hook
    const client = useTypeQLClient<TRouter>(); // Router type might be needed here or inferred
    const [data, setData] = React.useState<TOutput | undefined>(undefined);
    const [isLoading, setIsLoading] = React.useState(options?.enabled !== false); // Only start loading if enabled
    const [error, setError] = React.useState<Error | null>(null);

    // Serialize input for dependency array - basic JSON stringify, might need improvement
    const inputKey = useMemo(() => {
        try {
            return JSON.stringify(input);
        } catch {
            return String(input); // Fallback
        }
    }, [input]);

    React.useEffect(() => {
        if (options?.enabled === false) {
            // If disabled after being enabled, reset state
            if (isLoading || data || error) {
                setData(undefined);
                setIsLoading(false);
                setError(null);
            }
            return;
        }

        let isCancelled = false;
        setIsLoading(true);
        setError(null); // Reset error on new fetch

        const callQuery = async () => {
            try {
                // Directly use the passed procedure accessor if types align
                const queryFn = (procedure as any)?.query;
                if (typeof queryFn !== 'function') {
                    throw new Error("Invalid procedure object passed to useQuery.");
                }

                const result = await queryFn(input);
                if (!isCancelled) {
                    setData(result as TOutput); // Cast result
                    setIsLoading(false);
                }
            } catch (err: any) {
                 if (!isCancelled) {
                    setError(err instanceof Error ? err : new Error(String(err)));
                }
            }
        };

        callQuery();

        return () => {
            isCancelled = true;
        };
        // Use serialized input key in dependency array
    }, [procedure, inputKey, options?.enabled]); // Procedure reference should be stable if client is stable

    return { data, isLoading, error };
}

// --- Mutation Hook (Basic Implementation) ---

// Helper type to extract mutation procedures
type inferMutationInput<TProcedure> = TProcedure extends { mutate: (input: infer TInput) => any } ? TInput : never;
type inferMutationOutput<TProcedure> = TProcedure extends { mutate: (input: any) => Promise<infer TOutput> } ? TOutput : never;

/**
 * Basic hook to perform a TypeQL mutation.
 */
// Removed export keyword
function useMutation<
    TRouter extends AnyRouter,
    TProcedure extends /* Lookup procedure type */ any,
    TInput = inferMutationInput<TProcedure>,
    TOutput = inferMutationOutput<TProcedure>
>(
    procedure: TProcedure,
    // TODO: Add options like onSuccess, onError, onMutate (for optimistic updates)
): {
    mutate: (input: TInput) => Promise<TOutput | undefined>; // Function to trigger mutation
    isLoading: boolean;
    error: Error | null;
    data: TOutput | undefined; // Result of the last successful mutation
} {
    const client = useTypeQLClient<TRouter>(); // Get client
    const [isLoading, setIsLoading] = React.useState(false);
    const [error, setError] = React.useState<Error | null>(null);
    const [data, setData] = React.useState<TOutput | undefined>(undefined);

    // isMounted check to prevent state updates after unmount
    const isMounted = React.useRef(true);
    React.useEffect(() => {
        isMounted.current = true;
        return () => { isMounted.current = false; };
    }, []);

    const mutate = React.useCallback(async (input: TInput): Promise<TOutput | undefined> => {
        setIsLoading(true);
        setError(null);
        setData(undefined);

        try {
            const mutationFn = (procedure as any)?.mutate;
            if (typeof mutationFn !== 'function') {
                throw new Error("Invalid procedure object passed to useMutation.");
            }
            const result = await mutationFn(input);
            if (isMounted.current) {
                setData(result as TOutput);
                setIsLoading(false);
                // TODO: Call onSuccess option if provided
                return result as TOutput;
            }
        } catch (err: any) {
             if (isMounted.current) {
                const errorObj = err instanceof Error ? err : new Error(String(err));
                setError(errorObj);
                setIsLoading(false);
                // TODO: Call onError option if provided
             }
            // Do not re-throw here by default, let the caller check the error state
            // Or re-throw if that's the desired API? For now, don't re-throw.
        }
        return undefined; // Return undefined on error or unmount
    }, [procedure, client]); // Client dependency might not be needed if procedure ref is stable

    return { mutate, isLoading, error, data };
}

// --- Subscription Hook (Basic Implementation) ---

// Helper type to extract subscription procedures
type inferSubscriptionInput<TProcedure> = TProcedure extends { subscribe: (input: infer TInput, handlers: any) => any } ? TInput : never;
// How to infer the TOutput (data type) from the handlers? This is tricky.
// Maybe require explicit TOutput generic or infer from onData handler?
// For now, let's assume the caller knows the output type or use `unknown`.
// type inferSubscriptionOutput<TProcedure> = ???

/**
 * Basic hook to subscribe to a TypeQL subscription.
 */
// Removed export keyword
function useSubscription<
    TRouter extends AnyRouter,
    TProcedure extends /* Lookup procedure type */ any,
    TInput = inferSubscriptionInput<TProcedure>,
    TOutput = unknown // Placeholder for data type
>(
    procedure: TProcedure,
    input: TInput,
    handlers: { // Pass handlers directly
        onData: (data: TOutput) => void;
        onError?: (error: Error) => void;
        onEnd?: () => void;
    },
    options?: { enabled?: boolean }
): {
    status: 'idle' | 'subscribing' | 'subscribed' | 'error' | 'ended';
    error: Error | null;
} {
    const client = useTypeQLClient<TRouter>();
    const [status, setStatus] = React.useState<'idle' | 'subscribing' | 'subscribed' | 'error' | 'ended'>(
        options?.enabled !== false ? 'subscribing' : 'idle'
    );
    const [error, setError] = React.useState<Error | null>(null);

    // Memoize handlers to prevent unnecessary re-subscriptions if they are defined inline
    const stableHandlers = React.useRef(handlers);
    React.useEffect(() => {
        stableHandlers.current = handlers;
    }, [handlers]);

    // Serialize input for dependency array
    const inputKey = useMemo(() => {
        try {
            return JSON.stringify(input);
        } catch {
            return String(input); // Fallback
        }
    }, [input]);

    React.useEffect(() => {
        if (options?.enabled === false) {
            setStatus('idle');
            setError(null);
            return; // Do nothing if not enabled
        }

        setStatus('subscribing');
        setError(null);

        // Ensure SubscriptionHandlers type is correctly used
        const subscriptionHandlers: SubscriptionHandlers = {
            onData: (message: SubscriptionDataMessage) => { // Explicitly type message
                // Assuming message.data is the actual payload
                if (status !== 'subscribed') setStatus('subscribed'); // Move to subscribed on first data
                stableHandlers.current.onData(message.data as TOutput); // Access message.data
            },
            onError: (err) => { // Error object from typeql/core might be { message: string; code?: string }
                const errorObj = err instanceof Error ? err : new Error(String(err.message || 'Subscription error'));
                setError(errorObj);
                setStatus('error');
                stableHandlers.current.onError?.(errorObj);
            },
            onEnd: () => {
                setStatus('ended');
                stableHandlers.current.onEnd?.();
            },
            // onStart: () => setStatus('subscribed'), // Potentially use onStart if transport provides it
        };

        let unsubscribe: UnsubscribeFn = () => {}; // Initialize with empty function

        try {
            const subscribeFn = (procedure as any)?.subscribe;
            if (typeof subscribeFn !== 'function') {
                 throw new Error("Invalid procedure object passed to useSubscription.");
            }
            // Call subscribe and store the cleanup function
            unsubscribe = subscribeFn(input, subscriptionHandlers);
             // Consider moving setStatus('subscribed') here if transport confirms start immediately,
             // otherwise wait for first onData. For now, wait for onData.
        } catch (err: any) {
             const errorObj = err instanceof Error ? err : new Error(String(err));
             setError(errorObj);
             setStatus('error');
             stableHandlers.current.onError?.(errorObj);
        }

        // Cleanup function for the effect
        return () => {
            setStatus('idle'); // Reset status on unmount or dependency change
            setError(null);
            unsubscribe(); // Call the unsubscribe function returned by transport.subscribe
        };

    }, [procedure, inputKey, options?.enabled]); // Re-subscribe if procedure or input changes

    return { status, error };
}


console.log("@typeql/react basic context, hook, and useQuery/useMutation/useSubscription loaded.");

// Export the provider and hook
export { TypeQLProvider, useTypeQLClient, useQuery, useMutation, useSubscription };
// Context itself is usually not exported directly
