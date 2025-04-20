import { createContext, h, ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import type { createClient, OptimisticStore } from '@sylphlab/typeql-client';
// Use ReturnType to get the type of the client instance
type TypeQLClientInstance = ReturnType<typeof createClient>;

// Define the shape of the context value
export interface TypeQLContextValue<TState = any> {
  client: TypeQLClientInstance;
  store?: OptimisticStore<TState>;
}

// Create the context with a default value (null or undefined)
// Using undefined and checking in the hook is common practice
const TypeQLContext = createContext<TypeQLContextValue | undefined>(undefined);

// Define props for the provider component
export interface TypeQLProviderProps<TState = any> {
  client: TypeQLClientInstance; // Client is mandatory
  store?: OptimisticStore<TState>; // Store is optional
  children: ComponentChildren;
}

/**
 * Provides the TypeQL client and optional optimistic store to the component tree.
 */
export function TypeQLProvider<TState = any>({
  client,
  store,
  children,
}: TypeQLProviderProps<TState>) {
  // Memoize the context value if client/store could change, though typically they are stable
  // const contextValue = useMemo(() => ({ client, store }), [client, store]);
  // For simplicity now, assume client/store are stable for the provider's lifetime
  const contextValue: TypeQLContextValue<TState> = { client, store };

  // Correct usage: h(Component, props, children)
  return h(TypeQLContext.Provider, { value: contextValue }, children);
  // Or using JSX:
  // return (
  //   <TypeQLContext.Provider value={contextValue}>
  //     {children}
  //   </TypeQLContext.Provider>
  // );
}

/**
 * Hook to access the TypeQL client and optional optimistic store from the context.
 * Throws an error if used outside of a TypeQLProvider.
 */
export function useTypeQL<TState = any>(): TypeQLContextValue<TState> {
  const context = useContext(TypeQLContext);

  if (context === undefined) {
    throw new Error('useTypeQL must be used within a TypeQLProvider');
  }

  // Cast needed as useContext's default type might include undefined
  return context as TypeQLContextValue<TState>;
}
