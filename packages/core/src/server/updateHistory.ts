import type { SubscriptionDataMessage } from '../core/types'; // Use new message type

// NOTE: This history mechanism is based on the OLD ReqDelta model (topics, serverSeq).
// It might need significant rework or replacement depending on how TypeQL handles
// subscription consistency and recovery (e.g., if sequence numbers are optional or handled differently).

/** Interface for storing and retrieving historical update messages. */
export interface UpdateHistory<Delta = any> {
    /**
 * Adds a subscription data message to the history for a specific topic/path.
 * Handles pruning based on buffer size. Assumes messages have a sequence number.
 * @param topic The topic/path the message belongs to.
 * @param message The SubscriptionDataMessage to store. Requires `seq`.
 */
    addUpdate(topic: string, message: SubscriptionDataMessage): void; // Removed <Delta>

    /**
 * Retrieves a range of subscription data messages for a topic/path based on sequence numbers.
 * @param topic The topic/path to retrieve messages for.
 * @param fromSeqExclusive The sequence number *after* which to start retrieving messages.
 * @param toSeqInclusive The sequence number *up to which* (inclusive) to retrieve messages.
 * @returns An array of SubscriptionDataMessages in the specified range, ordered by sequence number. Returns empty array if range is invalid or unavailable.
 */
    getUpdates(topic: string, fromSeqExclusive: number, toSeqInclusive: number): SubscriptionDataMessage[]; // Removed <Delta>

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
export function createInMemoryUpdateHistory<Delta = any>(
    options: InMemoryUpdateHistoryOptions = {}
): UpdateHistory<Delta> {
    const { bufferSize = 1000 } = options;
    // Map<topic, SortedArray<SubscriptionDataMessage>> - Array is kept sorted by seq
    const history = new Map<string, SubscriptionDataMessage[]>(); // Removed <Delta>

    const addUpdate = (topic: string, message: SubscriptionDataMessage) => { // Removed <Delta>
        // Use message.seq instead of update.serverSeq
        if (message.seq === undefined || message.seq <= 0) {
             console.warn(`[TypeQL History] Ignoring message for topic "${topic}" without a valid positive seq:`, message);
             return;
        }

        if (!history.has(topic)) {
            history.set(topic, []);
        }
        const topicHistory = history.get(topic)!;

        // Simple insertion assuming messages mostly arrive in order.
        const lastMessage = topicHistory.length > 0 ? topicHistory[topicHistory.length - 1] : undefined;
        // Use message.seq
        if (lastMessage && lastMessage.seq !== undefined && message.seq <= lastMessage.seq) {
             console.warn(`[TypeQL History] Received out-of-order or duplicate message for topic "${topic}" (Seq: ${message.seq}, Last Seq: ${lastMessage.seq}). Ignoring.`);
             // Or handle insertion/replacement if needed.
             return;
        }

        topicHistory.push(message); // Push the new message type

        // Prune if buffer size exceeded
        if (topicHistory.length > bufferSize) {
            topicHistory.shift(); // Remove the oldest message
        }
    };

    // Correct the return type here - SubscriptionDataMessage is not generic
    const getUpdates = (topic: string, fromSeqExclusive: number, toSeqInclusive: number): SubscriptionDataMessage[] => {
        const topicHistory = history.get(topic);
        if (!topicHistory || fromSeqExclusive >= toSeqInclusive) {
            return [];
        }

        // Find messages within the range [fromSeqExclusive + 1, toSeqInclusive]
        // This assumes topicHistory is sorted by seq.
        const results: SubscriptionDataMessage[] = []; // Removed <Delta>
        for (const message of topicHistory) { // Use new message type
             // seq is guaranteed non-undefined by addUpdate logic
             const seq = message.seq!;
             if (seq > fromSeqExclusive && seq <= toSeqInclusive) {
                 results.push(message); // Push the new message type
             }
             // Optimization: If history is sorted, we can break early if seq > toSeqInclusive
             if (seq > toSeqInclusive) {
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
