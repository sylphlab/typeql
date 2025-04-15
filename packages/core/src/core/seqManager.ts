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

// Placeholder for potential server-side sequence management if needed in core
// export function createServerSequenceManager() { ... }
