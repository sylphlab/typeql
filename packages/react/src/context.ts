// packages/react/src/context.ts
import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
// Correct import paths using workspace alias
import {
    AnyRouter,
    TypeQLClientError, // Keep if needed by Provider/hook, maybe not directly here
    // TypeQLTransport, // Likely not needed directly here
    // UnsubscribeFn, // Likely not needed directly here
    // SubscriptionDataMessage, // Likely not needed directly here
    // SubscriptionErrorMessage, // Likely not needed directly here
    // ProcedureResultMessage, // Likely not needed directly here
} from '@sylphlab/typeql-shared'; // Shared types
import {
    createClient,
    OptimisticStore,
    // MutationCallOptions, // Likely not needed directly here
    // PredictedChange, // Likely not needed directly here
    OptimisticStoreOptions,
    OptimisticStoreError,
    createOptimisticStore,
} from '@sylphlab/typeql-client'; // Client specific imports


// --- Context ---

// Define the shape of the context value
export interface TypeQLContextValue<TRouter extends AnyRouter = AnyRouter, TState = any> {
    client: ReturnType<typeof createClient<TRouter>>; // The client proxy
    store?: OptimisticStore<TState>; // Optional optimistic store
}

// Create the context with a more specific type, using unknown for generics initially
// Keep internal unless needed externally
const TypeQLContext = createContext<TypeQLContextValue<AnyRouter, unknown> | null>(null);


// --- Provider ---

export interface TypeQLProviderProps<TRouter extends AnyRouter, TState = any> {
    /** The pre-configured TypeQL client instance. */
    client: ReturnType<typeof createClient<TRouter>>;
    /**
     * EITHER: A pre-instantiated OptimisticStore instance.
     * If provided, the provider assumes its `onError` handler is already configured.
     */
    store?: OptimisticStore<TState>;
    /**
     * OR: Options to create an OptimisticStore internally.
     * If provided, `store` prop must be omitted. The provider will manage the store instance.
     */
    storeOptions?: OptimisticStoreOptions<TState>;
    /**
     * Optional callback to handle asynchronous errors originating from the OptimisticStore
     * (e.g., timeouts, conflict resolution failures).
     * Only used if `storeOptions` are provided (i.e., the provider creates the store).
     */
    onStoreError?: (error: OptimisticStoreError) => void;
    /** The child components. */
    children: React.ReactNode;
}

/**
 * Provider component to make the TypeQL client and optional store available via context.
 * Can either accept a pre-instantiated store or create one internally based on options.
 * If creating internally, it manages the store's `onError` callback.
 */
export function TypeQLProvider<TRouter extends AnyRouter, TState = any>({
    client,
    store: storeProp,
    storeOptions,
    onStoreError,
    children,
}: TypeQLProviderProps<TRouter, TState>): React.ReactElement {
    if (storeProp && storeOptions) {
        throw new Error("TypeQLProvider cannot accept both 'store' and 'storeOptions' props.");
    }

    // Create store internally if options are provided
    const internalStoreRef = useRef<OptimisticStore<TState> | null>(null);
    if (storeOptions && !internalStoreRef.current) {
        console.log("[TypeQLProvider] Creating OptimisticStore internally with provided options.");
        // Configure onError for the internally created store
        const configuredOptions: OptimisticStoreOptions<TState> = {
            ...storeOptions, // Spread original options first
            deltaApplicator: storeOptions.deltaApplicator, // Explicitly pass deltaApplicator
            onError: (error: OptimisticStoreError) => { // Added explicit type for error
                // Log internally first
                console.error("[TypeQLProvider Internal Store Error]:", error);
                // Then call the user-provided handler
                onStoreError?.(error);
                // Also call the original onError from options if it existed
                storeOptions.onError?.(error);
            },
        };
        internalStoreRef.current = createOptimisticStore(configuredOptions);
    }

    // Determine the store instance to provide: prop > internal > undefined
    const providedStore = storeProp ?? internalStoreRef.current ?? undefined;

    // Memoize the context value object itself
    const contextValue = useMemo(() => ({
        client,
        store: providedStore,
    }), [client, providedStore]); // Dependencies include client and the determined store instance

    // Cleanup internally created store on unmount
    useEffect(() => {
        const internalStore = internalStoreRef.current;
        return () => {
            if (internalStore) {
                console.log("[TypeQLProvider] Cleaning up internally created OptimisticStore.");
                // Add any necessary cleanup logic for the store here, if applicable in the future
                // e.g., internalStore.destroy?.();
                internalStoreRef.current = null;
            }
        };
    }, []); // Empty dependency array ensures this runs only on mount and unmount

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