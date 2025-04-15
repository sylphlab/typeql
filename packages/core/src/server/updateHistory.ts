import type { UpdateMessage } from '../core/types';

/** Interface for storing and retrieving historical update messages. */
export interface UpdateHistory<Delta = any> {
    /**
     * Adds an update message to the history for a specific topic.
     * Handles pruning based on buffer size.
     * @param topic The topic the update belongs to.
     * @param update The UpdateMessage to store. Requires serverSeq.
     */
    addUpdate(topic: string, update: UpdateMessage<Delta>): void;

    /**
     * Retrieves a range of update messages for a topic based on sequence numbers.
     * @param topic The topic to retrieve updates for.
     * @param fromSeqExclusive The sequence number *after* which to start retrieving updates.
     * @param toSeqInclusive The sequence number *up to which* (inclusive) to retrieve updates.
     * @returns An array of UpdateMessages in the specified range, ordered by sequence number. Returns empty array if range is invalid or unavailable.
     */
    getUpdates(topic: string, fromSeqExclusive: number, toSeqInclusive: number): UpdateMessage<Delta>[];

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
    // Map<topic, SortedArray<UpdateMessage>> - Array is kept sorted by serverSeq
    const history = new Map<string, UpdateMessage<Delta>[]>();

    const addUpdate = (topic: string, update: UpdateMessage<Delta>) => {
        if (update.serverSeq === undefined || update.serverSeq <= 0) {
             console.warn(`[ReqDelta Server History] Ignoring update for topic "${topic}" without a valid positive serverSeq:`, update);
             return;
        }

        if (!history.has(topic)) {
            history.set(topic, []);
        }
        const topicHistory = history.get(topic)!;

        // Simple insertion assuming updates mostly arrive in order.
        const lastUpdate = topicHistory.length > 0 ? topicHistory[topicHistory.length - 1] : undefined;
        if (lastUpdate && lastUpdate.serverSeq !== undefined && update.serverSeq <= lastUpdate.serverSeq) {
             console.warn(`[ReqDelta Server History] Received out-of-order or duplicate update for topic "${topic}" (Seq: ${update.serverSeq}, Last Seq: ${lastUpdate.serverSeq}). Ignoring.`);
             // Or handle insertion/replacement if needed.
             return;
        }

        topicHistory.push(update);

        // Prune if buffer size exceeded
        if (topicHistory.length > bufferSize) {
            topicHistory.shift(); // Remove the oldest update
        }
    };

    const getUpdates = (topic: string, fromSeqExclusive: number, toSeqInclusive: number): UpdateMessage<Delta>[] => {
        const topicHistory = history.get(topic);
        if (!topicHistory || fromSeqExclusive >= toSeqInclusive) {
            return [];
        }

        // Find updates within the range [fromSeqExclusive + 1, toSeqInclusive]
        // This assumes topicHistory is sorted by serverSeq.
        const results: UpdateMessage<Delta>[] = [];
        for (const update of topicHistory) {
             // serverSeq is guaranteed non-undefined by addUpdate logic
             const seq = update.serverSeq!;
             if (seq > fromSeqExclusive && seq <= toSeqInclusive) {
                 results.push(update);
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
