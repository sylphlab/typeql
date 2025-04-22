import { createContext, h, type ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import type { createClient, OptimisticStore } from '@sylphlab/zen-query-client';
// Use ReturnType to get the type of the client instance
type zenQueryClientInstance = ReturnType<typeof createClient>;

// Define the shape of the context value
export interface zenQueryContextValue<TState = any> {
  client: zenQueryClientInstance;
  store?: OptimisticStore<TState>;
}

// Create the context with a default value (null or undefined)
// Using undefined and checking in the hook is common practice
const zenQueryContext = createContext<zenQueryContextValue | undefined>(undefined);

// Define props for the provider component
export interface zenQueryProviderProps<TState = any> {
  client: zenQueryClientInstance; // Client is mandatory
  store?: OptimisticStore<TState>; // Store is optional
  children: ComponentChildren;
}

/**
 * Provides the zenQuery client and optional optimistic store to the component tree.
 */
export function zenQueryProvider<TState = any>({
  client,
  store,
  children,
}: zenQueryProviderProps<TState>) {
  // Memoize the context value if client/store could change, though typically they are stable
  // const contextValue = useMemo(() => ({ client, store }), [client, store]);
  // For simplicity now, assume client/store are stable for the provider's lifetime
  const contextValue: zenQueryContextValue<TState> = { client, store };

  // Correct usage: h(Component, props, children)
  return h(zenQueryContext.Provider, { value: contextValue }, children);
  // Or using JSX:
  // return (
  //   <zenQueryContext.Provider value={contextValue}>
  //     {children}
  //   </zenQueryContext.Provider>
  // );
}

/**
 * Hook to access the zenQuery client and optional optimistic store from the context.
 * Throws an error if used outside of a zenQueryProvider.
 */
export function usezenQuery<TState = any>(): zenQueryContextValue<TState> {
  const context = useContext(zenQueryContext);

  if (context === undefined) {
    throw new Error('usezenQuery must be used within a zenQueryProvider');
  }

  // Cast needed as useContext's default type might include undefined
  return context as zenQueryContextValue<TState>;
}
