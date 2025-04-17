import type { SubscriptionDataMessage } from '@sylphlab/typeql-shared';
/** Interface for storing and retrieving historical update messages. */
export interface UpdateHistory {
    /**
 * Adds a subscription data message to the history for a specific topic/path.
 * Handles pruning based on buffer size. Assumes messages have a `serverSeq`.
 * @param topic The topic/path the message belongs to.
 * @param message The SubscriptionDataMessage to store. Requires `serverSeq`.
 */
    addUpdate(topic: string, message: SubscriptionDataMessage): void;
    /**
 * Retrieves a range of subscription data messages for a topic/path based on sequence numbers.
 * @param topic The topic/path to retrieve messages for.
 * @param fromSeqExclusive The *server* sequence number *after* which to start retrieving messages.
 * @param toSeqInclusive The *server* sequence number *up to which* (inclusive) to retrieve messages.
 * @returns An array of SubscriptionDataMessages in the specified range, ordered by `serverSeq`. Returns empty array if range is invalid or unavailable.
 */
    getUpdates(topic: string, fromSeqExclusive: number, toSeqInclusive: number): SubscriptionDataMessage[];
    /**
     * Clears all history for a specific topic.
     * @param topic The topic to clear history for.
     */
    clearTopicHistory(topic: string): void;
    /**
     * Clears the entire update history.
     */
    clearAllHistory(): void;
}
/** Configuration options for the in-memory update history. */
export interface InMemoryUpdateHistoryOptions {
    /** Maximum number of updates to store per topic. Defaults to 1000. */
    bufferSize?: number;
}
/**
 * Creates an in-memory implementation of the UpdateHistory.
 * Stores updates in a Map keyed by topic, with each topic holding an array of updates.
 * Automatically prunes older updates when the buffer size is exceeded.
 */
export declare function createInMemoryUpdateHistory(options?: InMemoryUpdateHistoryOptions): UpdateHistory;
//# sourceMappingURL=updateHistory.d.ts.map