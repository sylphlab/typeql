import type { ProcedureResultMessage, SubscriptionDataMessage, SubscriptionErrorMessage } from '@sylphlab/zen-query-shared';

// Helper type for pending requests
export type PendingRequest = {
    resolve: (value: ProcedureResultMessage) => void;
    reject: (reason?: any) => void;
};

// Helper type for active subscriptions
export type ActiveSubscription<T = unknown> = {
    // Queue for incoming data/errors
    buffer: Array<SubscriptionDataMessage | SubscriptionErrorMessage>;
    // Resolver for the next promise in the iterator
    resolveNext: ((value: IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>) => void) | null;
    // Rejector for the iterator promise (e.g., on error or unsubscribe)
    rejectIterator: ((reason?: any) => void) | null;
    // Flag indicating the subscription has ended from the server or unsubscribed
    isComplete: boolean;
};