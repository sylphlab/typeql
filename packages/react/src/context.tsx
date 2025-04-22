import React, { createContext, useContext, type ReactNode } from 'react';
import type { createClient, OptimisticStore } from '@sylphlab/zen-query-client';

// Use ReturnType to get the type of the client instance
type zenQueryClientInstance = ReturnType<typeof createClient>;

// Define the shape of the context value
export interface zenQueryContextValue<TState = any> {
  client: zenQueryClientInstance;
  store?: OptimisticStore<TState>;
}

// Create the context with a default value (undefined)
// Using undefined and checking in the hook is common practice
const zenQueryContext = createContext<zenQueryContextValue | undefined>(undefined);

// Define props for the provider component
export interface zenQueryProviderProps<TState = any> {
  client: zenQueryClientInstance; // Client is mandatory
  store?: OptimisticStore<TState>; // Store is optional
  children: ReactNode; // Use ReactNode for children
}

/**
 * Provides the zenQuery client and optional optimistic store to the component tree.
 */
export function zenQueryProvider<TState = any>({
  client,
  store,
  children,
}: zenQueryProviderProps<TState>) {
  // Memoization could be added here if client/store stability is a concern
  const contextValue: zenQueryContextValue<TState> = { client, store };

  return (
    <zenQueryContext.Provider value={contextValue}>
      {children}
    </zenQueryContext.Provider>
  );
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

  // Type assertion might be needed depending on strictness, but useContext should infer correctly here
  return context;
}