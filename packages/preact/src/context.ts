// packages/preact/src/context.ts
import { createContext, h, FunctionalComponent, ComponentChildren } from 'preact';
import { useContext, useMemo } from 'preact/hooks';
import {
    AnyRouter,
    TypeQLClientError, // Keep potentially needed error type? Or remove if unused here.
} from '@sylphlab/typeql-shared';
import { createClient, OptimisticStore } from '@sylphlab/typeql-client';

// --- Context ---

// Define the shape of the context value
export interface TypeQLContextValue<TRouter extends AnyRouter = AnyRouter, TState = any> {
    client: ReturnType<typeof createClient<TRouter>>; // The client proxy
    store?: OptimisticStore<TState>; // Optional optimistic store
}

// Create the context with a more specific type, using unknown for generics initially
// Exporting for potential direct use, though useTypeQL is preferred
export const TypeQLContext = createContext<TypeQLContextValue<AnyRouter, unknown> | null>(null);


// --- Provider ---

export interface TypeQLProviderProps<TRouter extends AnyRouter, TState = any> {
  client: ReturnType<typeof createClient<TRouter>>; // Expect the client proxy
  store?: OptimisticStore<TState>; // Optional store
  children: ComponentChildren; // Use Preact's ComponentChildren
}

/**
 * Provider component to make the TypeQL client and optional store available via context.
 */
export const TypeQLProvider: FunctionalComponent<TypeQLProviderProps<any, any>> = ({
    client,
    store,
    children,
}) => {
    // Memoize the context value object itself
    const contextValue = useMemo(() => ({
        client,
        store,
    }), [client, store]);

    // Cast the value to match the context type signature
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
    const context = useContext<TypeQLContextValue<AnyRouter, any> | null>(TypeQLContext);
    if (!context) {
        // Throwing the specific error here
        throw new Error('`useTypeQL` must be used within a `TypeQLProvider`.');
    }
    // Cast needed as the context is created with `AnyRouter` and `unknown` state
    return context as TypeQLContextValue<TRouter, TState>;
}