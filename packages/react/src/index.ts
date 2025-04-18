// packages/react/src/index.ts

// Re-export context and provider
export { TypeQLProvider, useTypeQL } from './context';
export type { TypeQLProviderProps, TypeQLContextValue } from './context';

// Re-export hooks
export { useTypeQLClient } from './hooks/useTypeQLClient';
export { useQuery } from './hooks/useQuery';
export type { UseQueryOptions, UseQueryResult } from './hooks/useQuery';
export { useMutation } from './hooks/useMutation';
export type { UseMutationOptions, UseMutationResult } from './hooks/useMutation';
export { useSubscription } from './hooks/useSubscription';
export type { UseSubscriptionOptions, UseSubscriptionResult } from './hooks/useSubscription';

// Re-export client/shared types and functions
export * from './client';
