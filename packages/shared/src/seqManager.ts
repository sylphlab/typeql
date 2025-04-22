/**
 * Manages sequence numbers.
 * TODO: Implement client-side sequence generation and potentially server-side tracking.
 */

export function createClientSequenceManager() {
    let clientSeq = 0;
    return {
        getNext: () => ++clientSeq,
        getCurrent: () => clientSeq,
        // Potentially add methods to handle server sequence tracking
    };
}

/**
 * Creates a manager for server-side sequence numbers.
 * This provides a simple global counter. A more complex implementation
 * might manage sequences per topic.
 * @param initialSeq The sequence number to start from (default: 0).
 */
export function createServerSequenceManager(initialSeq = 0) {
    let serverSeq = initialSeq;
    return {
        /** Gets the next available server sequence number. */
        getNext: () => ++serverSeq,
        /** Gets the current highest assigned server sequence number. */
        getCurrent: () => serverSeq,
        /** Resets the sequence number (e.g., for testing or specific scenarios). */
        reset: (newStart = 0) => { serverSeq = newStart; },
    };
}

// Export types for convenience
export type ClientSequenceManager = ReturnType<typeof createClientSequenceManager>;
export type ServerSequenceManager = ReturnType<typeof createServerSequenceManager>;