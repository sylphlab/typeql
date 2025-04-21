# OptimisticSyncCoordinator Design (v1.0)

Based on `zenquery_technical_guidelines_v1.md` (Section C.2).

## 1. Positioning and Goals

*   **Role:** Stateless synchronization logic engine within each `zenQuery` client instance.
*   **Responsibilities:** Manage client/server sequence numbers, handle the pending mutation queue, process server messages (Ack, Delta, Error), orchestrate conflict resolution, and trigger external state updates/recomputations via callbacks.
*   **Statelessness:** Does *not* hold application state (e.g., user lists). Interacts with the state layer (e.g., Nanostore Atoms) indirectly via patches and callbacks.

## 2. Type Definitions

```typescript
// Assuming JSON Patch (RFC 6902) format
type Patch = { op: string; path: string; value?: any; from?: string };

// Unique identifier for a state atom (e.g., Nanostore atom)
type AtomKey = string | symbol;

// Structure for pending mutations in the queue
type PendingMutation = {
  clientSeq: number;
  mutationInfo: any; // Metadata about the mutation (e.g., name, input)
  optimisticPatches: Map<AtomKey, Patch[]>; // Patches applied optimistically
  // Note: Inverse patches might be stored here or calculated on demand during rollback
};

// Structure for server delta messages
type ServerDeltaMessage = {
  data: any; // The actual delta payload (e.g., JSON Patch array or full snapshot)
  serverSeq: number;
  prevServerSeq?: number; // Optional: Previous sequence number for strict ordering checks
};

// Function signature for applying a resolved delta to the confirmed state
type ApplyDeltaCallback = (resolvedDelta: any) => void; // 'any' should be refined based on delta format (e.g., Patch[])

// Function signature for applying inverse patches during rollback
type RollbackCallback = (inversePatches: Map<AtomKey, Patch[]>) => void;

// Function signature for notifying that optimistic state needs recalculation
type StateChangeCallback = () => void;

// Interface for a configurable conflict resolution strategy
interface ConflictResolutionStrategy {
  /**
   * Resolves conflicts between server delta and pending mutations.
   * @param serverDelta The incoming delta from the server.
   * @param pendingPatches Patches from mutations that haven't been confirmed before this delta.
   * @returns The resolved delta to be applied to the confirmed state.
   */
  resolve(serverDelta: any, pendingPatches: Map<AtomKey, Patch[]>): any; // 'any' should be refined
}
```

## 3. Interface Definition

```typescript
interface OptimisticSyncCoordinator {
  // --- Internal State (Conceptual) ---
  // confirmedServerSeq: number; // Highest server sequence number confirmed and applied
  // pendingMutations: PendingMutation[]; // Queue of mutations sent but not yet confirmed/rejected

  // --- Methods ---

  /**
   * Generates a unique, monotonically increasing sequence number for a new client mutation.
   * @returns The next client sequence number.
   */
  generateClientSeq(): number;

  /**
   * Registers a mutation that has been sent to the server but not yet acknowledged.
   * Stores the mutation details and the optimistic patches applied to the client state.
   * @param data - Information about the pending mutation.
   */
  registerPendingMutation(data: {
    clientSeq: number;
    mutationInfo: any;
    optimisticPatches: Map<AtomKey, Patch[]>;
    // Consider adding inversePatches here if pre-calculated
  }): void;

  /**
   * Processes a confirmation (Ack) message from the server for a specific mutation.
   * Removes the confirmed mutation from the pending queue.
   * May trigger onStateChange if the removal affects optimistic state calculation.
   * @param clientSeq - The sequence number of the confirmed mutation.
   */
  confirmMutation(clientSeq: number): void;

  /**
   * Processes a rejection message from the server for a specific mutation.
   * Calculates the necessary inverse patches to revert the optimistic update.
   * Triggers the onRollback callback with the calculated inverse patches.
   * Removes the rejected mutation from the pending queue.
   * May trigger onStateChange.
   * @param clientSeq - The sequence number of the rejected mutation.
   * @param error - Optional error information from the server.
   */
  rejectMutation(clientSeq: number, error?: any): void;

  /**
   * Processes an incoming delta message from the server.
   * 1. Checks sequence numbers (serverSeq, prevServerSeq) against confirmedServerSeq for ordering.
   * 2. Identifies relevant pending mutations (those not confirmed before this delta).
   * 3. Calls the configured ConflictResolutionStrategy to resolve conflicts between the server delta and pending patches.
   * 4. Updates confirmedServerSeq.
   * 5. Triggers the onApplyDelta callback with the *resolved* delta.
   * 6. May trigger onStateChange if server data affects optimistic calculations.
   * @param deltaMessage - The delta message received from the server.
   * @param conflictResolver - The strategy instance for resolving conflicts.
   */
  processServerDelta(
    deltaMessage: ServerDeltaMessage,
    conflictResolver: ConflictResolutionStrategy
  ): void;

  /**
   * Retrieves the aggregated optimistic patches from all currently valid pending mutations.
   * This is used by external logic (e.g., Binding Helpers) to compute the optimistic state.
   * @returns A map where keys are AtomKeys and values are arrays of patches to apply for that atom.
   */
  getPendingPatches(): Map<AtomKey, Patch[]>;

  // --- Event Subscription Methods ---

  /**
   * Registers a callback to be invoked when the Coordinator's internal state changes
   * in a way that might require recalculating the optimistic state (e.g., pending queue changes,
   * confirmed sequence updates affecting conflict resolution).
   * @param callback - The function to call on state change.
   * @returns A function to unsubscribe the callback.
   */
  onStateChange(callback: StateChangeCallback): () => void;

  /**
   * Registers a callback to be invoked after processServerDelta has resolved conflicts
   * and determined the final delta that should be applied to the confirmed state.
   * @param callback - The function to call with the resolved delta.
   * @returns A function to unsubscribe the callback.
   */
  onApplyDelta(callback: ApplyDeltaCallback): () => void;

  /**
   * Registers a callback to be invoked when a mutation rejection requires rolling back
   * optimistic updates.
   * @param callback - The function to call with the inverse patches needed for rollback.
   * @returns A function to unsubscribe the callback.
   */
  onRollback(callback: RollbackCallback): () => void;
}
```

## 4. Core Logic Outline

1.  **Sequence Number Management:**
    *   `generateClientSeq`: Uses an internal counter.
    *   `confirmedServerSeq`: Internal state tracking the latest applied server sequence.
    *   `processServerDelta`: Performs strict sequence checks (`prevServerSeq`, `serverSeq`) before processing and updates `confirmedServerSeq` on success.
2.  **Pending Mutations Management:**
    *   `registerPendingMutation`: Adds mutation details and patches to an internal queue.
    *   `confirmMutation`: Removes the mutation by `clientSeq`, triggers `onStateChange`.
    *   `rejectMutation`: Removes mutation, calculates/retrieves inverse patches, triggers `onRollback` and `onStateChange`.
    *   `getPendingPatches`: Aggregates patches from the current queue, grouped by `AtomKey`.
3.  **Delta Processing & Conflict Resolution:**
    *   `processServerDelta`: After sequence checks, identifies pending mutations not covered by the incoming delta's sequence. Extracts their patches and passes them along with the server delta to the `conflictResolver`. Triggers `onApplyDelta` with the *resolved* delta. Updates `confirmedServerSeq`. May trigger `onStateChange`.
4.  **Rollback Handling:**
    *   `rejectMutation`: Calculates or retrieves pre-calculated inverse patches for the rejected mutation's optimistic updates. Triggers `onRollback` with these inverse patches.
5.  **State Recalculation Trigger (`onStateChange`):**
    *   Triggered by `confirmMutation`, `rejectMutation`, and potentially `processServerDelta` whenever the internal state changes might affect the computed optimistic state.

## 5. Statelessness Enforcement

The Coordinator remains stateless regarding application data by:
*   Operating only on sequence numbers, metadata, and patches.
*   Using `getPendingPatches` to provide patch data for external optimistic state calculation.
*   Using `onApplyDelta` and `onRollback` callbacks to delegate the application of resolved deltas and inverse patches to the external state layer.
*   Using `onStateChange` to signal *when* recalculation is needed, not *how* to do it.