// Main entry point for @sylphlab/zen-query-react

export { zenQueryProvider, usezenQuery } from './context.js'; // Updated extension
export type { zenQueryProviderProps, zenQueryContextValue } from './context.js'; // Updated extension

export { useQuery } from './hooks/useQuery';
export type { UseQueryOptions, UseQueryResult } from './hooks/useQuery';

export { useMutation } from './hooks/useMutation';
export type { UseMutationOptions, UseMutationResult } from './hooks/useMutation';

export { useSubscription } from './hooks/useSubscription';
export type { UseSubscriptionOptions, UseSubscriptionResult, SubscriptionStatus } from './hooks/useSubscription';

// Re-export client types if needed, or let users import from @sylphlab/zen-query-client directly
// export type { OptimisticStore, MutationCallOptions, zenQueryClientError } from '@sylphlab/zen-query-client';