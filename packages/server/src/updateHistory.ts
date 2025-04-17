import type { SubscriptionDataMessage } from '@sylphlab/typeql-shared';

// NOTE: This history mechanism is based on the OLD ReqDelta model (topics, serverSeq).
// It might need significant rework or replacement depending on how TypeQL handles
// subscription consistency and recovery (e.g., if sequence numbers are optional or handled differently).

/** Interface for storing and retrieving historical update messages. */
export interface UpdateHistory { // Removed unused Delta generic
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

     // Optional: prune method if needed externally
     // pruneHistory(topic: string): void;
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
export function createInMemoryUpdateHistory(
    options: InMemoryUpdateHistoryOptions = {}
): UpdateHistory { // Removed <Delta> generic
    const { bufferSize = 1000 } = options;
    // Map<topic, SortedArray<SubscriptionDataMessage>> - Array is kept sorted by serverSeq
    const history = new Map<string, SubscriptionDataMessage[]>();

    const addUpdate = (topic: string, message: SubscriptionDataMessage) => {
        // Use message.serverSeq instead of message.seq
        if (message.serverSeq === undefined || message.serverSeq <= 0) {
             console.warn(`[TypeQL History] Ignoring message for topic "${topic}" without a valid positive serverSeq:`, message);
             return;
        }

        if (!history.has(topic)) {
            history.set(topic, []);
        }
        const topicHistory = history.get(topic)!;

        // Simple insertion assuming messages mostly arrive in order based on serverSeq.
        const lastMessage = topicHistory.length > 0 ? topicHistory[topicHistory.length - 1] : undefined;
        // Use message.serverSeq
        if (lastMessage && lastMessage.serverSeq !== undefined && message.serverSeq <= lastMessage.serverSeq) {
             console.warn(`[TypeQL History] Received out-of-order or duplicate message for topic "${topic}" (serverSeq: ${message.serverSeq}, Last serverSeq: ${lastMessage.serverSeq}). Ignoring.`);
             // Or handle insertion/replacement if needed.
             return;
        }

        topicHistory.push(message);

        // Prune if buffer size exceeded
        if (topicHistory.length > bufferSize) {
            topicHistory.shift(); // Remove the oldest message
        }
    };

    // Ensure return type matches interface
    const getUpdates = (topic: string, fromSeqExclusive: number, toSeqInclusive: number): SubscriptionDataMessage[] => {
        const topicHistory = history.get(topic);
        if (!topicHistory || fromSeqExclusive >= toSeqInclusive) {
            return [];
        }

        // Find messages within the range [fromSeqExclusive + 1, toSeqInclusive] based on serverSeq
        // This assumes topicHistory is sorted by serverSeq.
        const results: SubscriptionDataMessage[] = [];
        for (const message of topicHistory) {
             // serverSeq is guaranteed non-undefined by addUpdate logic
             const serverSeq = message.serverSeq!;
             if (serverSeq > fromSeqExclusive && serverSeq <= toSeqInclusive) {
                 results.push(message);
             }
             // Optimization: If history is sorted, we can break early if serverSeq > toSeqInclusive
             if (serverSeq > toSeqInclusive) {
                 break;
             }
        }
        return results;
    };

     const clearTopicHistory = (topic: string) => {
         history.delete(topic);
     };

     const clearAllHistory = () => {
         history.clear();
     };

    return {
        addUpdate,
        getUpdates,
        clearTopicHistory,
        clearAllHistory,
    };
}
