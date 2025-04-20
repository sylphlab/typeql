// Main entry point for @sylphlab/typeql-react

export { TypeQLProvider, useTypeQL } from './context.js'; // Updated extension
export type { TypeQLProviderProps, TypeQLContextValue } from './context.js'; // Updated extension

export { useQuery } from './hooks/useQuery';
export type { UseQueryOptions, UseQueryResult } from './hooks/useQuery';

export { useMutation } from './hooks/useMutation';
export type { UseMutationOptions, UseMutationResult } from './hooks/useMutation';

export { useSubscription } from './hooks/useSubscription';
export type { UseSubscriptionOptions, UseSubscriptionResult, SubscriptionStatus } from './hooks/useSubscription';

// Re-export client types if needed, or let users import from @sylphlab/typeql-client directly
// export type { OptimisticStore, MutationCallOptions, TypeQLClientError } from '@sylphlab/typeql-client';