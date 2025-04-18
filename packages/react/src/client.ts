// packages/react/src/client.ts

// Re-export relevant types and functions from @sylphlab/typeql-shared
export type {
    AnyRouter,
    TypeQLClientError,
    TypeQLTransport,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    ProcedureResultMessage,
} from '@sylphlab/typeql-shared';

// Re-export relevant types and functions from @sylphlab/typeql-client
export type {
    OptimisticStore,
    MutationCallOptions,
    PredictedChange,
    OptimisticStoreOptions,
    OptimisticStoreError,
} from '@sylphlab/typeql-client';
export { createClient, createOptimisticStore } from '@sylphlab/typeql-client';