import { type Operation as PatchOperation, applyPatch } from 'fast-json-patch';
import { nanoid } from 'nanoid'; // Assuming nanoid is installed now
import { createNanoEvents, type Emitter } from 'nanoevents'; // Corrected import source

// TODO: Define these types more robustly, potentially in shared package
export type ServerDelta = {
	serverSeq: number;
	clientId?: string; // ID of the client who originated the mutation (if applicable)
	clientSeq?: number; // Sequence number from the originating client (if applicable)
	patches: PatchOperation[];
	key: string; // Added key to identify the target atom/subscription
};

// Use AtomKey type from registry
import type { AtomKey } from './utils/atomRegistry';

export type PendingMutation = {
	clientSeq: number;
	// Store patches mapped by the AtomKey they affect
	patchesByAtom: Map<AtomKey, PatchOperation[]>;
	inversePatchesByAtom: Map<AtomKey, PatchOperation[]>;
	// Add other relevant metadata if needed (e.g., timestamp)
};

export type CoordinatorOptions = {
	initialServerSeq?: number;
	// Add other options like conflict resolution strategy later
};

export type CoordinatorEvents = {
	/** Emitted when the effective state might have changed due to confirmations or rollbacks */
	onStateChange: () => void;
	/** Emitted when a server delta (potentially resolved) should be applied to the local state */
	onApplyDelta: (delta: ServerDelta) => void; // Delta now includes the key
	/** Emitted when a pending mutation needs to be rolled back */
	onRollback: (inversePatchesByAtom: Map<AtomKey, PatchOperation[]>) => void; // Emit Map
	/** Emitted when a mutation is successfully acknowledged by the server */
	onAck: (clientSeq: number, result?: any) => void;
	/** Emitted when a mutation is rejected by the server or coordinator */
	onError: (clientSeq: number, error: any) => void;
};

/**
 * Coordinates optimistic updates and server synchronization.
 * Manages sequence numbers and pending mutations, emitting events
 * for the client to apply changes or rollbacks to the actual application state.
 */
export class OptimisticSyncCoordinator {
	private confirmedServerSeq: number;
	private clientSeqCounter: number;
	private pendingMutations: PendingMutation[];
	private emitter: Emitter<CoordinatorEvents>;

	constructor(options: CoordinatorOptions = {}) {
		this.confirmedServerSeq = options.initialServerSeq ?? 0;
		this.clientSeqCounter = 0;
		this.pendingMutations = [];
		this.emitter = createNanoEvents<CoordinatorEvents>();
	}

	on<E extends keyof CoordinatorEvents>(event: E, callback: CoordinatorEvents[E]) {
		return this.emitter.on(event, callback);
	}

	/** Generates a unique sequence number for a new client-side mutation. */
	generateClientSeq(): number {
		this.clientSeqCounter += 1;
		return this.clientSeqCounter;
	}

	/**
	 * Registers a mutation that has been optimistically applied locally.
	 * @param clientSeq The sequence number obtained from `generateClientSeq`.
	 * @param patches The JSON patches representing the mutation.
	 * @param inversePatches Patches to revert the mutation (placeholder).
	 */
	registerPendingMutation(
		clientSeq: number,
		// Expect maps instead of flat arrays
		patchesByAtom: Map<AtomKey, PatchOperation[]>,
		inversePatchesByAtom: Map<AtomKey, PatchOperation[]>
	): void {
		// Basic validation
		if (this.pendingMutations.some((m) => m.clientSeq === clientSeq)) {
			console.warn(`[OptimisticSyncCoordinator] Mutation with clientSeq ${clientSeq} already registered.`);
			return;
		}
		// Ensure maps are not empty? Or handle downstream.
		if (patchesByAtom.size === 0) {
			console.warn(`[OptimisticSyncCoordinator] Registering mutation with clientSeq ${clientSeq} but no patches provided.`);
			// Allow registration even without patches? Might be valid for some mutations.
		}
		this.pendingMutations.push({
			clientSeq,
			patchesByAtom,
			inversePatchesByAtom,
		});
		// Sort by clientSeq to maintain order
		this.pendingMutations.sort((a, b) => a.clientSeq - b.clientSeq);
		// Emit state change as adding a pending mutation affects optimistic state
		this.emitter.emit('onStateChange');
	}

	/**
	 * Confirms a pending mutation that the server has successfully processed.
	 * @param clientSeq The sequence number of the mutation to confirm.
	 * @param result Optional result payload from the server for the mutation.
	 */
	// Add optional result parameter
	confirmMutation(clientSeq: number, result?: any): void {
	 const initialLength = this.pendingMutations.length;
	 const mutationIndex = this.pendingMutations.findIndex(m => m.clientSeq === clientSeq);

	 if (mutationIndex !== -1) {
	 	this.pendingMutations.splice(mutationIndex, 1); // Remove the confirmed mutation

	 	// Emit Ack event with the result
	 	this.emitter.emit('onAck', clientSeq, result);
	 	// Emit state change as pending queue changed
	 	this.emitter.emit('onStateChange');
		}
	}

	/**
	 * Rejects a pending mutation that the server could not process.
	 * Triggers a rollback event.
	 * @param clientSeq The sequence number of the mutation to reject.
	 * @param error The error object or message indicating the reason for rejection.
	 */
	// Add error parameter
	rejectMutation(clientSeq: number, error?: any): void {
	 const mutationIndex = this.pendingMutations.findIndex(
	 	(m) => m.clientSeq === clientSeq
	 );

		if (mutationIndex === -1) {
			console.warn(`[OptimisticSyncCoordinator] Cannot reject mutation with clientSeq ${clientSeq}: Not found.`);
			return;
		}

		// For rollback, we need to apply the inverse of the rejected mutation
		// AND all subsequent pending mutations.
		const mutationsToRollback = this.pendingMutations.slice(mutationIndex);
		// Compute inverse patches as a Map<AtomKey, PatchOperation[]>
		const inversePatchesByAtom = new Map<AtomKey, PatchOperation[]>();
		mutationsToRollback.reverse().forEach(m => { // Apply inverses in reverse order
			m.inversePatchesByAtom.forEach((patches, key) => {
				const existing = inversePatchesByAtom.get(key) ?? [];
				// Add patches to the beginning to ensure correct application order (older first)
		        // Actually, order depends on how applyPatches works. Let's concat for now.
				inversePatchesByAtom.set(key, existing.concat(patches));
			});
		});

		// Remove the rejected mutation and subsequent ones from the pending queue
		this.pendingMutations.splice(mutationIndex);

		if (inversePatchesByAtom.size > 0) {
			this.emitter.emit('onRollback', inversePatchesByAtom); // Emit the Map
		}

		// After rollback, the state might have changed effectively
		this.emitter.emit('onStateChange');
	}

	/**
	 * Processes an incoming delta (change) from the server.
	 * Handles sequence checking, conflict resolution (placeholder), and applies the delta.
	 * @param delta The delta received from the server.
	 */
	processServerDelta(delta: ServerDelta): void {
		// 1. Sequence Check (Basic Gap Detection Placeholder)
		if (delta.serverSeq <= this.confirmedServerSeq) {
			console.warn(
				`[OptimisticSyncCoordinator] Received stale delta (serverSeq ${delta.serverSeq} <= confirmed ${this.confirmedServerSeq}). Ignoring.`
			);
			return;
		}
		if (delta.serverSeq > this.confirmedServerSeq + 1) {
			console.error(
				`[OptimisticSyncCoordinator] Detected gap in server sequence (received ${delta.serverSeq}, expected ${this.confirmedServerSeq + 1}). State potentially inconsistent. Requesting resync or handling gap... (Placeholder)`
			);
			// Placeholder: In a real implementation, trigger a resync mechanism here.
			// For now, we might just update the sequence and hope for the best, or stop processing.
			// Let's cautiously update the sequence for now, but this needs proper handling.
			this.confirmedServerSeq = delta.serverSeq - 1; // Try to recover
		}

		let resolvedDelta = delta;
		let requireRollback = false;
		let rollbackPatches: PatchOperation[] = [];

		// 2. Conflict Resolution (if delta originated from another client or is a correction)
		if (this.pendingMutations.length > 0) {
			// Placeholder: Simple strategy - assume conflict if pending mutations exist
			// A real implementation needs Operational Transformation (OT) or
			// Conflict-free Replicated Data Types (CRDT) logic, or a server-resolved approach.
			console.warn(
				`[OptimisticSyncCoordinator] Potential conflict detected (pending mutations exist). Applying basic resolution... (Placeholder)`
			);

			// Basic Placeholder: Rollback all pending, apply server, reapply transformed pending
			this.pendingMutations.slice().reverse().forEach(m => {
				m.inversePatchesByAtom.forEach(patches => {
					rollbackPatches.push(...patches);
				});
			});
			requireRollback = true;

			// Placeholder: Transform pending mutations against server delta (NO-OP for now)
			// This needs to operate on the patches within the maps
			const transformedPending = this.pendingMutations.map((m) => {
				const transformedPatchesByAtom = new Map<AtomKey, PatchOperation[]>();
				m.patchesByAtom.forEach((patches, key) => {
					// Apply transformation logic here based on delta.patches against 'patches'
					// For now, return original patches (incorrect but placeholder)
					transformedPatchesByAtom.set(key, [...patches]); // Return copies
				});
				// TODO: Transform inversePatchesByAtom as well?
				return { ...m, patchesByAtom: transformedPatchesByAtom, inversePatchesByAtom: new Map(m.inversePatchesByAtom) }; // Return copies
			});
			this.pendingMutations = transformedPending;
		}

		// 3. Apply Rollback if needed (before applying server delta)
		if (requireRollback) {
			// Construct the Map for rollback emission
			const rollbackPatchesByAtom = new Map<AtomKey, PatchOperation[]>();
			this.pendingMutations.slice().reverse().forEach(m => { // Use pendingMutations before they are transformed
				m.inversePatchesByAtom.forEach((patches, key) => {
					const existing = rollbackPatchesByAtom.get(key) ?? [];
					rollbackPatchesByAtom.set(key, existing.concat(patches));
				});
			});
			if (rollbackPatchesByAtom.size > 0) {
				this.emitter.emit('onRollback', rollbackPatchesByAtom); // Emit the Map
			}
		}

		// 4. Emit event to apply the (potentially resolved) server delta
		this.emitter.emit('onApplyDelta', resolvedDelta);

		// 5. Update confirmed server sequence
		this.confirmedServerSeq = resolvedDelta.serverSeq;

		// 6. Remove confirmed/obviated pending mutations
		// 6. Confirm mutation if this delta corresponds to one
		// Note: This assumes server delta includes clientSeq if it's an ack.
		// A dedicated 'ack' message might be cleaner.
		const initialPendingLength = this.pendingMutations.length;
		let mutationConfirmed = false;
		if (delta.clientSeq) {
			const mutationIndex = this.pendingMutations.findIndex(m => m.clientSeq === delta.clientSeq);
			if (mutationIndex !== -1) {
				this.pendingMutations.splice(mutationIndex, 1);
				// TODO: Should delta contain the mutation result to pass to onAck? Assume undefined for now.
				this.emitter.emit('onAck', delta.clientSeq, undefined);
				mutationConfirmed = true;
			}
		}

		// 7. Emit state change if pending mutations changed, after potential rollback/rebase, or mutation confirmed
		if (requireRollback || mutationConfirmed) {
			this.emitter.emit('onStateChange');
		}
	}

	/**
	 * Gets the list of patches representing the current optimistically applied state
	 * (i.e., all pending mutations combined), potentially grouped by AtomKey.
	 * TODO: Decide on the return type. Flat array or Map? Guideline C.2 implies Map.
	 * (i.e., all pending mutations combined), grouped by AtomKey.
	 */
	getPendingPatches(): Map<AtomKey, PatchOperation[]> {
	 const mergedMap = new Map<AtomKey, PatchOperation[]>();
	 this.pendingMutations.forEach(m => {
	     m.patchesByAtom.forEach((patches, key) => {
	         const existing = mergedMap.get(key) ?? [];
	         // Add patches to the beginning to ensure correct application order (older first)
	         // Actually, order depends on how applyPatches works. Let's concat for now.
	         // Revisit if order issues arise.
	         mergedMap.set(key, existing.concat(patches));
	     });
	 });
	 return mergedMap;
	}

	/** Gets the last confirmed sequence number received from the server. */
	getConfirmedServerSeq(): number {
		return this.confirmedServerSeq;
	}

	/** Checks if there are any mutations awaiting server confirmation. */
	hasPendingMutations(): boolean {
		return this.pendingMutations.length > 0;
	}

	// --- Placeholder/Helper Methods ---

	/**
	 * Placeholder for calculating the inverse of a set of patches.
	 * In a real implementation, this might involve analyzing patch operations
	 * or requiring the server/mutation source to provide inverses.
	 */
	private calculateInversePatch(patches: PatchOperation[]): PatchOperation[] {
		console.warn('[OptimisticSyncCoordinator] calculateInversePatch is a placeholder.');
		// For now, assume the inverse is magically provided or derivable (e.g., simple swaps)
		// Returning an empty array as a basic placeholder.
		return [];
	}

	/**
	 * Placeholder for resolving conflicts between server patches and pending client patches.
	 * This is where OT or CRDT logic would reside.
	 */
	private resolveConflict(
		serverPatches: PatchOperation[],
		pendingMutation: PendingMutation
	): {
		transformedServerPatches: PatchOperation[];
		transformedPendingPatches: PatchOperation[];
	} {
		console.warn('[OptimisticSyncCoordinator] resolveConflict is a placeholder.');
		// No-op transformation for now
		// Placeholder needs to reference the map
		return {
			transformedServerPatches: serverPatches,
			// This needs to return a Map or handle transformation per key
			transformedPendingPatches: pendingMutation.patchesByAtom.values().next().value ?? [], // Incorrect placeholder
		};
	}
}
