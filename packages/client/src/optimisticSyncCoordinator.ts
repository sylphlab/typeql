import type { Operation as JsonPatchOperation } from 'fast-json-patch';

// Define core types based on guidelines (RFC 6902 for patches)
export type Patch = JsonPatchOperation;
export type AtomKey = string | symbol; // Or a more specific type if needed

// TODO: Define a more specific type for mutation details
export interface MutationInfo {
  path: string;
  input: any;
}

export interface PendingMutation {
  clientSeq: number;
  mutationInfo: MutationInfo;
  optimisticPatches: Map<AtomKey, Patch[]>;
  inversePatches?: Map<AtomKey, Patch[]>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  // Add timestamp?
  createdAt: number;
}

export interface ServerDelta {
  // Assuming server sends JSON patches
  patches?: Patch[];
  // Or potentially other data structures for full state sync?
  fullState?: any; // Example if server can send full state
  [key: string]: any;
}

// Removed DeltaApplicator interface as we use event emission

type CoordinatorEvent = 'stateChange' | 'applyDelta' | 'rollback' | 'requestMissing';
type Listener<T = any> = (data: T) => void;

export interface OptimisticSyncCoordinatorOptions {
  /** Initial sequence number confirmed by the server. Defaults to -1. */
  initialServerSeq?: number;
  /** Timeout in milliseconds for pending mutations. Defaults to 10000 (10s). */
  mutationTimeoutMs?: number;
}

/**
 * Manages optimistic updates and synchronization logic between client and server.
 * Stateless regarding application data itself.
 */
export class OptimisticSyncCoordinator {
  private clientSeqCounter = 0;
  private confirmedServerSeq: number;
  private pendingMutations = new Map<number, PendingMutation>();
  private listeners = new Map<CoordinatorEvent, Set<Listener>>();
  private mutationTimeoutMs: number;

  constructor(options: OptimisticSyncCoordinatorOptions = {}) {
    this.confirmedServerSeq = options.initialServerSeq ?? -1;
    this.mutationTimeoutMs = options.mutationTimeoutMs ?? 10000;
  }

  // --- Event Emitter ---

  private emit<T>(event: CoordinatorEvent, data: T): void {
    // Use setTimeout to avoid potential issues with listeners modifying state
    // during the emit cycle, especially if listeners trigger further emits.
    setTimeout(() => {
        this.listeners.get(event)?.forEach(listener => {
            try {
                listener(data);
            } catch (error) {
                console.error(`[OptimisticSyncCoordinator] Error in listener for event "${event}":`, error);
            }
        });
    }, 0);
  }

  public onStateChange(callback: () => void): () => void {
    return this.subscribe('stateChange', callback);
  }

  public onApplyDelta(callback: (resolvedDelta: ServerDelta) => void): () => void {
    return this.subscribe('applyDelta', callback);
  }

  public onRollback(callback: (inversePatches: Map<AtomKey, Patch[]>) => void): () => void {
    return this.subscribe('rollback', callback);
  }

  /** Emitted when a gap in server sequence numbers is detected. */
  public onRequestMissing(callback: (details: { from: number; to: number }) => void): () => void {
    return this.subscribe('requestMissing', callback);
  }


  private subscribe<T>(event: CoordinatorEvent, listener: Listener<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const eventListeners = this.listeners.get(event)!;
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  // --- Core Methods ---

  /**
   * Sets the initial confirmed server sequence number, e.g., after initial data load.
   */
  public setInitialServerSeq(seq: number): void {
    if (this.confirmedServerSeq === -1 && this.pendingMutations.size === 0) {
        this.confirmedServerSeq = seq;
        console.log(`[OptimisticSyncCoordinator] Initial server sequence set to ${seq}`);
    } else {
        console.warn(`[OptimisticSyncCoordinator] Cannot set initial server sequence when already initialized or pending mutations exist.`);
    }
  }

  /**
   * Generates a unique sequence number for a new client mutation.
   */
  public generateClientSeq(): number {
    this.clientSeqCounter += 1;
    return this.clientSeqCounter;
  }

  /**
   * Registers a mutation that has been applied optimistically.
   * @param data Details of the pending mutation.
   */
  public registerPendingMutation(data: {
    clientSeq: number;
    mutationInfo: MutationInfo;
    optimisticPatches: Map<AtomKey, Patch[]>;
    inversePatches?: Map<AtomKey, Patch[]>;
  }): void {
    if (this.pendingMutations.has(data.clientSeq)) {
      console.warn(`[OptimisticSyncCoordinator] Mutation with clientSeq ${data.clientSeq} already registered.`);
      return;
    }

    const timeoutTimer = setTimeout(() => {
        console.warn(`[OptimisticSyncCoordinator] Mutation ${data.clientSeq} timed out after ${this.mutationTimeoutMs}ms.`);
        // Treat timeout as a rejection
        this.handleMutationRejection(data.clientSeq, new Error('Mutation timed out'));
    }, this.mutationTimeoutMs);

    const pending: PendingMutation = {
      ...data,
      timeoutTimer,
      createdAt: Date.now(),
    };
    this.pendingMutations.set(data.clientSeq, pending);
    this.emit('stateChange', undefined); // Notify that pending state changed
  }

  /**
   * Confirms a mutation previously registered.
   * Typically called when an Ack message is received from the server.
   * @param clientSeq The sequence number of the mutation confirmed by the server.
   * @param serverSeq Optional: The server sequence number associated with this confirmation, if provided by the server Ack.
   */
  public confirmMutation(clientSeq: number, serverSeq?: number): void {
    const mutation = this.pendingMutations.get(clientSeq);
    if (!mutation) {
      console.warn(`[OptimisticSyncCoordinator] Received confirmation for unknown clientSeq ${clientSeq}.`);
      return;
    }

    clearTimeout(mutation.timeoutTimer);
    this.pendingMutations.delete(clientSeq);

    // If server provides a sequence number with the Ack, update our confirmed sequence.
    // This helps if deltas arrive before the Ack for the mutation that caused them.
    if (serverSeq !== undefined && serverSeq > this.confirmedServerSeq) {
        // TODO: This assumes ACKs arrive in order relative to their effects.
        // If an older ACK arrives after a newer delta, this could wrongly advance the sequence.
        // A more robust system might track sequence per mutation or use a different mechanism.
        // For now, only advance if the ACK's sequence is newer.
        // console.log(`[OptimisticSyncCoordinator] Advancing confirmedServerSeq to ${serverSeq} based on Ack for clientSeq ${clientSeq}`);
        // this.confirmedServerSeq = serverSeq;
        // Revisit this logic - ACKs confirming mutations might not directly correlate
        // with the sequence number of the *delta* resulting from that mutation.
        // Sticking to advancing sequence only via processServerDelta for now.
    }

    // Only emit stateChange if a mutation was actually removed
    this.emit('stateChange', undefined);
  }

  /**
   * Rejects a mutation previously registered.
   * Typically called when an Error message is received from the server for a mutation.
   * @param clientSeq The sequence number of the mutation rejected by the server.
   * @param error Optional error information from the server.
   */
  public rejectMutation(clientSeq: number, error?: any): void {
    this.handleMutationRejection(clientSeq, error);
  }

  /** Internal handler for rejection logic (used by rejectMutation and timeout) */
  private handleMutationRejection(clientSeq: number, error?: any): void {
    const mutation = this.pendingMutations.get(clientSeq);
    if (!mutation) {
      // Might have already been timed out and handled
      // console.warn(`[OptimisticSyncCoordinator] Rejection handling for unknown clientSeq ${clientSeq}.`);
      return;
    }

    clearTimeout(mutation.timeoutTimer);
    this.pendingMutations.delete(clientSeq);

    // Trigger rollback calculation and event
    if (mutation.inversePatches && mutation.inversePatches.size > 0) {
        // TODO: Implement more robust rollback.
        // If subsequent pending mutations exist, their optimistic patches might
        // have been based on the state *after* the rejected mutation.
        // Simply applying the inverse might lead to an incorrect state.
        // A full rollback might involve:
        // 1. Applying inverse patches for the rejected mutation.
        // 2. Applying inverse patches for ALL subsequent pending mutations.
        // 3. Re-applying optimistic patches for subsequent pending mutations based on the new state.
        // For now, emit the simple inverse patches and let the UI layer handle potential inconsistencies or trigger a refetch.
        console.warn(`[OptimisticSyncCoordinator] Rolling back mutation ${clientSeq}. Subsequent pending mutations may need re-evaluation.`);
        this.emit('rollback', mutation.inversePatches);
    } else {
        console.warn(`[OptimisticSyncCoordinator] Mutation ${clientSeq} rejected/timed out, but no inverse patches available for direct rollback. Triggering state change for potential refetch/recomputation.`);
        // Trigger stateChange so UI can potentially refetch or recompute from confirmed state
        this.emit('stateChange', undefined);
    }

    // Notify state change as pending queue is modified (already done by emitting rollback or stateChange)
    // this.emit('stateChange', undefined);

    if (error) {
        console.error(`[OptimisticSyncCoordinator] Mutation ${clientSeq} rejected/timed out:`, error);
        // TODO: Potentially emit an error event for UI handling
    }
  }


  /**
   * Processes an incoming delta from the server.
   * Handles sequence checking, triggers delta application, and state recomputation.
   * @param deltaMessage The delta message from the server.
   */
  public processServerDelta(
    deltaMessage: { data: ServerDelta; serverSeq: number; prevServerSeq?: number }
  ): void {
    const { data: serverDelta, serverSeq, prevServerSeq } = deltaMessage;

    // --- Sequence Checking ---
    const expectedPrevSeq = this.confirmedServerSeq;

    // Ignore old deltas
    if (serverSeq <= this.confirmedServerSeq) {
        console.log(`[OptimisticSyncCoordinator] Ignoring old server delta ${serverSeq} (confirmed: ${this.confirmedServerSeq})`);
        return;
    }

    // Check for gaps
    if (prevServerSeq !== undefined && prevServerSeq !== expectedPrevSeq) {
      console.warn(`[OptimisticSyncCoordinator] Server delta sequence mismatch. Expected prev ${expectedPrevSeq}, got ${prevServerSeq}. ServerSeq: ${serverSeq}. Requesting missing deltas.`);
      // Emit event to request missing deltas from the transport layer
      this.emit('requestMissing', { from: expectedPrevSeq + 1, to: serverSeq -1 });
      // TODO: Should we queue this delta or discard it? Discarding for now.
      return;
    }

    // --- Conflict Resolution (Placeholder/Basic) ---
    // Assuming server state is the source of truth.
    // More complex strategies (e.g., operational transforms, client-wins with rebase) are not implemented here.
    // We simply apply the server delta to the confirmed state externally via onApplyDelta,
    // and then recompute the optimistic state by reapplying pending patches via onStateChange.
    const resolvedDelta = serverDelta;

    // --- Update Confirmed Sequence ---
    this.confirmedServerSeq = serverSeq;

    // --- Trigger Application ---
    // Emit event for external handler (e.g., Nanostore binding) to apply the delta
    // to the confirmed state representation.
    this.emit('applyDelta', resolvedDelta);

    // --- Trigger Recomputation ---
    // Since server state changed (or sequence advanced), optimistic state needs recomputation.
    this.emit('stateChange', undefined);
  }

  /**
   * Gets the combined optimistic patches from all currently pending mutations,
   * ordered by client sequence number.
   * The caller is responsible for applying these patches sequentially to the confirmed state.
   * @returns A map where keys are AtomKeys and values are arrays of patches to apply.
   */
  public getPendingPatches(): Map<AtomKey, Patch[]> {
    const allPatches = new Map<AtomKey, Patch[]>();

    // Iterate through pending mutations in order (clientSeq)
    const sortedClientSeqs = Array.from(this.pendingMutations.keys()).sort((a, b) => a - b);

    for (const clientSeq of sortedClientSeqs) {
      const mutation = this.pendingMutations.get(clientSeq)!;
      for (const [atomKey, patches] of mutation.optimisticPatches.entries()) {
        if (!allPatches.has(atomKey)) {
          allPatches.set(atomKey, []);
        }
        // Ensure patches are applied in the correct order for each atom
        allPatches.get(atomKey)!.push(...patches);
      }
    }

    return allPatches;
  }

  /** Gets the current confirmed server sequence number. */
  public getConfirmedServerSeq(): number {
    return this.confirmedServerSeq;
  }

  /** Gets the number of pending mutations. */
  public getPendingMutationCount(): number {
    return this.pendingMutations.size;
  }
}