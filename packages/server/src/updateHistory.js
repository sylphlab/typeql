/**
 * Creates an in-memory implementation of the UpdateHistory.
 * Stores updates in a Map keyed by topic, with each topic holding an array of updates.
 * Automatically prunes older updates when the buffer size is exceeded.
 */
export function createInMemoryUpdateHistory(options = {}) {
    const { bufferSize = 1000 } = options;
    // Map<topic, SortedArray<SubscriptionDataMessage>> - Array is kept sorted by serverSeq
    const history = new Map();
    const addUpdate = (topic, message) => {
        // Use message.serverSeq instead of message.seq
        if (message.serverSeq === undefined || message.serverSeq <= 0) {
            console.warn(`[TypeQL History] Ignoring message for topic "${topic}" without a valid positive serverSeq:`, message);
            return;
        }
        if (!history.has(topic)) {
            history.set(topic, []);
        }
        const topicHistory = history.get(topic);
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
    const getUpdates = (topic, fromSeqExclusive, toSeqInclusive) => {
        const topicHistory = history.get(topic);
        if (!topicHistory || fromSeqExclusive >= toSeqInclusive) {
            return [];
        }
        // Find messages within the range [fromSeqExclusive + 1, toSeqInclusive] based on serverSeq
        // This assumes topicHistory is sorted by serverSeq.
        const results = [];
        for (const message of topicHistory) {
            // serverSeq is guaranteed non-undefined by addUpdate logic
            const serverSeq = message.serverSeq;
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
    const clearTopicHistory = (topic) => {
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
//# sourceMappingURL=updateHistory.js.map