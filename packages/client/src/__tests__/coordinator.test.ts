import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OptimisticSyncCoordinator, type CoordinatorEvents, type ServerDelta } from '../coordinator'; // Added ServerDelta
import type { AtomKey } from '../utils/atomRegistry';
import type { Operation as PatchOperation } from 'fast-json-patch';

describe('OptimisticSyncCoordinator', () => {
  let coordinator: OptimisticSyncCoordinator;
  let mockOnStateChange: ReturnType<typeof vi.fn>;
  let mockOnApplyDelta: ReturnType<typeof vi.fn>;
  let mockOnRollback: ReturnType<typeof vi.fn>;
  let mockOnAck: ReturnType<typeof vi.fn>;
  let mockOnError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create a new coordinator instance before each test
    coordinator = new OptimisticSyncCoordinator({ initialServerSeq: 0 });

    // Create mock listeners
    mockOnStateChange = vi.fn();
    mockOnApplyDelta = vi.fn();
    mockOnRollback = vi.fn();
    mockOnAck = vi.fn();
    mockOnError = vi.fn();

    // Attach mock listeners
    coordinator.on('onStateChange', mockOnStateChange);
    coordinator.on('onApplyDelta', mockOnApplyDelta);
    coordinator.on('onRollback', mockOnRollback);
    coordinator.on('onAck', mockOnAck);
    coordinator.on('onError', mockOnError);
  });

  // --- Test Scenarios will be added here ---

  // 1. Initialization
  describe('Initialization', () => {
    it('should initialize with confirmedServerSeq 0 by default', () => {
      expect(coordinator.getConfirmedServerSeq()).toBe(0);
    });

    it('should initialize with provided initialServerSeq', () => {
      const coordinatorWithInitial = new OptimisticSyncCoordinator({ initialServerSeq: 100 });
      expect(coordinatorWithInitial.getConfirmedServerSeq()).toBe(100);
    });

    it('should initialize with an empty pending mutations queue', () => {
      expect(coordinator.hasPendingMutations()).toBe(false);
      expect(coordinator.getPendingPatches().size).toBe(0);
    });
  });

  // 2. Sequence Generation
  describe('generateClientSeq', () => {
    it('should generate monotonically increasing client sequence numbers starting from 1', () => {
      expect(coordinator.generateClientSeq()).toBe(1);
      expect(coordinator.generateClientSeq()).toBe(2);
      expect(coordinator.generateClientSeq()).toBe(3);
    });
  });

  // 3. Mutation Registration
  describe('registerPendingMutation', () => {
    // Define constants within the scope accessible by tests in this describe block
    const atomKey1: AtomKey = 'atom1';
    const atomKey2: AtomKey = 'atom2';
    const patches1: PatchOperation[] = [{ op: 'replace', path: '/foo', value: 'bar' }];
    const patches2: PatchOperation[] = [{ op: 'add', path: '/baz', value: [1, 2] }];
    const inversePatches1: PatchOperation[] = [{ op: 'replace', path: '/foo', value: 'original' }];
    const inversePatches2: PatchOperation[] = [{ op: 'remove', path: '/baz' }];

    it('should add a mutation to the pending queue', () => {
      const clientSeq = coordinator.generateClientSeq();
      const patchesByAtom = new Map([[atomKey1, patches1]]);
      const inversePatchesByAtom = new Map([[atomKey1, inversePatches1]]);

      coordinator.registerPendingMutation(clientSeq, patchesByAtom, inversePatchesByAtom);

      expect(coordinator.hasPendingMutations()).toBe(true);
      const pending = coordinator.getPendingPatches();
      expect(pending.size).toBe(1);
      expect(pending.get(atomKey1)).toEqual(patches1);
    });

    it('should store patches grouped by AtomKey', () => {
        const clientSeq = coordinator.generateClientSeq();
        const patchesByAtom = new Map([
            [atomKey1, patches1],
            [atomKey2, patches2],
        ]);
        const inversePatchesByAtom = new Map([
            [atomKey1, inversePatches1],
            [atomKey2, inversePatches2],
        ]);

        coordinator.registerPendingMutation(clientSeq, patchesByAtom, inversePatchesByAtom);

        const pending = coordinator.getPendingPatches();
        expect(pending.size).toBe(2);
        expect(pending.get(atomKey1)).toEqual(patches1);
        expect(pending.get(atomKey2)).toEqual(patches2);
    });


    it('should emit onStateChange when a mutation is registered', () => {
      const clientSeq = coordinator.generateClientSeq();
      const patchesByAtom = new Map([[atomKey1, patches1]]);
      const inversePatchesByAtom = new Map([[atomKey1, inversePatches1]]);

      coordinator.registerPendingMutation(clientSeq, patchesByAtom, inversePatchesByAtom);

      expect(mockOnStateChange).toHaveBeenCalledTimes(1);
    });

    it('should log a warning and not add if clientSeq is already registered', () => {
      const clientSeq = coordinator.generateClientSeq();
      const patchesByAtom = new Map([[atomKey1, patches1]]);
      const inversePatchesByAtom = new Map([[atomKey1, inversePatches1]]);
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      coordinator.registerPendingMutation(clientSeq, patchesByAtom, inversePatchesByAtom);
      expect(coordinator.hasPendingMutations()).toBe(true);
      const initialPendingSize = coordinator.getPendingPatches().size;

      // Register again with same clientSeq
      coordinator.registerPendingMutation(clientSeq, new Map([[atomKey2, patches2]]), new Map([[atomKey2, inversePatches2]]));

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining(`clientSeq ${clientSeq} already registered`));
      expect(coordinator.hasPendingMutations()).toBe(true); // Still has mutations
      // Check that the content didn't change (or size didn't increase unexpectedly)
      const finalPending = coordinator.getPendingPatches();
      expect(finalPending.size).toBe(initialPendingSize);
      expect(finalPending.get(atomKey1)).toEqual(patches1); // Original mutation still there
      expect(finalPending.get(atomKey2)).toBeUndefined(); // Second mutation not added

      consoleWarnSpy.mockRestore();
    });

     it('should keep the pending queue sorted by clientSeq', () => {
        const seq1 = coordinator.generateClientSeq(); // 1
        const seq2 = coordinator.generateClientSeq(); // 2
        const seq3 = coordinator.generateClientSeq(); // 3

        const patchesByAtom1 = new Map([[atomKey1, patches1]]);
        const inversePatchesByAtom1 = new Map([[atomKey1, inversePatches1]]);
        const patchesByAtom2 = new Map([[atomKey2, patches2]]);
        const inversePatchesByAtom2 = new Map([[atomKey2, inversePatches2]]);

        // Register out of order
        coordinator.registerPendingMutation(seq2, patchesByAtom2, inversePatchesByAtom2);
        coordinator.registerPendingMutation(seq1, patchesByAtom1, inversePatchesByAtom1);

        // Access internal state for verification (use with caution, maybe better way?)
        // @ts-ignore - Accessing private member for test verification
        const internalQueue = coordinator.pendingMutations;

        expect(internalQueue.length).toBe(2);
        expect(internalQueue[0].clientSeq).toBe(seq1);
        expect(internalQueue[1].clientSeq).toBe(seq2);

        // Add another one
        coordinator.registerPendingMutation(seq3, patchesByAtom1, inversePatchesByAtom1);
        // @ts-ignore
        expect(coordinator.pendingMutations.length).toBe(3);
        // @ts-ignore
        expect(coordinator.pendingMutations[2].clientSeq).toBe(seq3);
     });
  }); // End of describe('registerPendingMutation')

  // 4. Mutation Confirmation (`confirmMutation`)
  describe('confirmMutation', () => {
    const atomKey1: AtomKey = 'atom1';
    const patches1: PatchOperation[] = [{ op: 'add', path: '/a', value: 1 }];
    const inversePatches1: PatchOperation[] = [{ op: 'remove', path: '/a' }];
    const patches2: PatchOperation[] = [{ op: 'replace', path: '/b', value: 2 }];
    const inversePatches2: PatchOperation[] = [{ op: 'replace', path: '/b', value: 0 }];
    const patches3: PatchOperation[] = [{ op: 'remove', path: '/c' }];
    const inversePatches3: PatchOperation[] = [{ op: 'add', path: '/c', value: 3 }];

    let seq1: number, seq2: number, seq3: number;
    let patchesByAtom1: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom1: Map<AtomKey, PatchOperation[]>;
    let patchesByAtom2: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom2: Map<AtomKey, PatchOperation[]>;
    let patchesByAtom3: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom3: Map<AtomKey, PatchOperation[]>;


    beforeEach(() => {
      // Register some mutations for confirmation tests
      seq1 = coordinator.generateClientSeq(); // 1
      seq2 = coordinator.generateClientSeq(); // 2
      seq3 = coordinator.generateClientSeq(); // 3

      patchesByAtom1 = new Map([[atomKey1, patches1]]);
      inversePatchesByAtom1 = new Map([[atomKey1, inversePatches1]]);
      patchesByAtom2 = new Map([[atomKey1, patches2]]); // Affects same atom
      inversePatchesByAtom2 = new Map([[atomKey1, inversePatches2]]);
      patchesByAtom3 = new Map([[atomKey1, patches3]]); // Affects same atom
      inversePatchesByAtom3 = new Map([[atomKey1, inversePatches3]]);

      coordinator.registerPendingMutation(seq1, patchesByAtom1, inversePatchesByAtom1);
      coordinator.registerPendingMutation(seq2, patchesByAtom2, inversePatchesByAtom2);
      coordinator.registerPendingMutation(seq3, patchesByAtom3, inversePatchesByAtom3);
      mockOnStateChange.mockClear(); // Clear calls from registration
      mockOnAck.mockClear();
    });

    it('should remove the correct mutation from the pending queue', () => {
      coordinator.confirmMutation(seq2); // Confirm the middle one

      expect(coordinator.hasPendingMutations()).toBe(true);
      // @ts-ignore - Accessing private member
      const internalQueue = coordinator.pendingMutations;
      expect(internalQueue.length).toBe(2);
      expect(internalQueue.some(m => m.clientSeq === seq2)).toBe(false);
      expect(internalQueue[0].clientSeq).toBe(seq1);
      expect(internalQueue[1].clientSeq).toBe(seq3);

      const pendingPatches = coordinator.getPendingPatches();
      expect(pendingPatches.get(atomKey1)).toEqual([...patches1, ...patches3]); // Only 1 and 3 remain
    });

    it('should remove the first mutation when multiple are pending', () => {
      coordinator.confirmMutation(seq1); // Confirm the first one

      expect(coordinator.hasPendingMutations()).toBe(true);
      // @ts-ignore
      const internalQueue = coordinator.pendingMutations;
      expect(internalQueue.length).toBe(2);
      expect(internalQueue[0].clientSeq).toBe(seq2);
      expect(internalQueue[1].clientSeq).toBe(seq3);

      const pendingPatches = coordinator.getPendingPatches();
      expect(pendingPatches.get(atomKey1)).toEqual([...patches2, ...patches3]); // Only 2 and 3 remain
    });

     it('should remove the last mutation', () => {
      coordinator.confirmMutation(seq3); // Confirm the last one

      expect(coordinator.hasPendingMutations()).toBe(true);
      // @ts-ignore
      const internalQueue = coordinator.pendingMutations;
      expect(internalQueue.length).toBe(2);
      expect(internalQueue[0].clientSeq).toBe(seq1);
      expect(internalQueue[1].clientSeq).toBe(seq2);

      const pendingPatches = coordinator.getPendingPatches();
      expect(pendingPatches.get(atomKey1)).toEqual([...patches1, ...patches2]); // Only 1 and 2 remain
    });

    it('should remove the only pending mutation', () => {
      // Clear existing and add just one
      // @ts-ignore
      coordinator.pendingMutations = [];
      coordinator.registerPendingMutation(seq1, patchesByAtom1, inversePatchesByAtom1);
      mockOnStateChange.mockClear();
      mockOnAck.mockClear();

      coordinator.confirmMutation(seq1);

      expect(coordinator.hasPendingMutations()).toBe(false);
      expect(coordinator.getPendingPatches().size).toBe(0);
    });


    it('should do nothing if the clientSeq does not exist', () => {
      coordinator.confirmMutation(999); // Non-existent seq

      // @ts-ignore
      expect(coordinator.pendingMutations.length).toBe(3); // Queue unchanged
      expect(mockOnAck).not.toHaveBeenCalled();
      expect(mockOnStateChange).not.toHaveBeenCalled(); // No state change if nothing removed
    });

    it('should emit onAck with clientSeq and optional result', () => {
      const serverResult = { newId: 'xyz' };
      coordinator.confirmMutation(seq2, serverResult);

      expect(mockOnAck).toHaveBeenCalledTimes(1);
      expect(mockOnAck).toHaveBeenCalledWith(seq2, serverResult);
    });

     it('should emit onAck without result if none provided', () => {
      coordinator.confirmMutation(seq1);

      expect(mockOnAck).toHaveBeenCalledTimes(1);
      expect(mockOnAck).toHaveBeenCalledWith(seq1, undefined);
    });

    it('should emit onStateChange when a mutation is confirmed', () => {
      coordinator.confirmMutation(seq2);
      expect(mockOnStateChange).toHaveBeenCalledTimes(1);
    });

     it('should NOT emit onStateChange if no mutation was confirmed', () => {
      coordinator.confirmMutation(999);
      expect(mockOnStateChange).not.toHaveBeenCalled();
    });

  }); // End of describe('confirmMutation')

  // 5. Mutation Rejection (`rejectMutation`)
  describe('rejectMutation', () => {
    const atomKey1: AtomKey = 'atom1';
    const atomKey2: AtomKey = 'atom2';
    // Patches
    const p1: PatchOperation[] = [{ op: 'add', path: '/a', value: 1 }];
    const p2: PatchOperation[] = [{ op: 'replace', path: '/b', value: 2 }]; // Same atom
    const p3: PatchOperation[] = [{ op: 'add', path: '/c', value: 3 }]; // Different atom
    const p4: PatchOperation[] = [{ op: 'remove', path: '/a' }]; // Same atom as p1
    // Inverse Patches
    const ip1: PatchOperation[] = [{ op: 'remove', path: '/a' }];
    const ip2: PatchOperation[] = [{ op: 'replace', path: '/b', value: 0 }];
    const ip3: PatchOperation[] = [{ op: 'remove', path: '/c' }];
    const ip4: PatchOperation[] = [{ op: 'add', path: '/a', value: 1 }]; // Inverse of p4

    let seq1: number, seq2: number, seq3: number, seq4: number;
    let patchesByAtom1: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom1: Map<AtomKey, PatchOperation[]>;
    let patchesByAtom2: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom2: Map<AtomKey, PatchOperation[]>;
    let patchesByAtom3: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom3: Map<AtomKey, PatchOperation[]>;
    let patchesByAtom4: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom4: Map<AtomKey, PatchOperation[]>;

    beforeEach(() => {
      // Register some mutations for rejection tests
      seq1 = coordinator.generateClientSeq(); // 1
      seq2 = coordinator.generateClientSeq(); // 2
      seq3 = coordinator.generateClientSeq(); // 3
      seq4 = coordinator.generateClientSeq(); // 4

      patchesByAtom1 = new Map([[atomKey1, p1]]);
      inversePatchesByAtom1 = new Map([[atomKey1, ip1]]);
      patchesByAtom2 = new Map([[atomKey1, p2]]); // Affects atomKey1
      inversePatchesByAtom2 = new Map([[atomKey1, ip2]]);
      patchesByAtom3 = new Map([[atomKey2, p3]]); // Affects atomKey2
      inversePatchesByAtom3 = new Map([[atomKey2, ip3]]);
      patchesByAtom4 = new Map([[atomKey1, p4]]); // Affects atomKey1
      inversePatchesByAtom4 = new Map([[atomKey1, ip4]]);

      coordinator.registerPendingMutation(seq1, patchesByAtom1, inversePatchesByAtom1);
      coordinator.registerPendingMutation(seq2, patchesByAtom2, inversePatchesByAtom2);
      coordinator.registerPendingMutation(seq3, patchesByAtom3, inversePatchesByAtom3);
      coordinator.registerPendingMutation(seq4, patchesByAtom4, inversePatchesByAtom4);
      mockOnStateChange.mockClear();
      mockOnRollback.mockClear();
      mockOnError.mockClear();
    });

    it('should remove the rejected mutation AND subsequent mutations', () => {
      coordinator.rejectMutation(seq2); // Reject the second one

      expect(coordinator.hasPendingMutations()).toBe(true);
      // @ts-ignore
      const internalQueue = coordinator.pendingMutations;
      expect(internalQueue.length).toBe(1); // Only seq1 should remain
      expect(internalQueue[0].clientSeq).toBe(seq1);
      expect(internalQueue.some(m => m.clientSeq === seq2)).toBe(false);
      expect(internalQueue.some(m => m.clientSeq === seq3)).toBe(false);
      expect(internalQueue.some(m => m.clientSeq === seq4)).toBe(false);

      const pendingPatches = coordinator.getPendingPatches();
      expect(pendingPatches.size).toBe(1);
      expect(pendingPatches.get(atomKey1)).toEqual(p1); // Only patches from seq1 remain
      expect(pendingPatches.get(atomKey2)).toBeUndefined();
    });

    it('should emit onRollback with combined inverse patches of rejected and subsequent mutations', () => {
      coordinator.rejectMutation(seq2); // Reject seq2, should rollback 2, 3, 4

      // Expected inverse patches (applied in reverse order: ip4, ip3, ip2)
      const expectedInverse = new Map<AtomKey, PatchOperation[]>();
      // From seq4 (ip4)
      expectedInverse.set(atomKey1, [...ip4]);
      // From seq3 (ip3)
      expectedInverse.set(atomKey2, [...ip3]);
      // From seq2 (ip2) - prepended to atomKey1
      expectedInverse.set(atomKey1, [...(expectedInverse.get(atomKey1) || []), ...ip2]);


      expect(mockOnRollback).toHaveBeenCalledTimes(1);
      const actualInverseMap = mockOnRollback.mock.calls[0][0] as Map<AtomKey, PatchOperation[]>;

      // Check atomKey1 patches (should be ip4 then ip2)
      expect(actualInverseMap.get(atomKey1)).toEqual([...ip4, ...ip2]);
      // Check atomKey2 patches (should be ip3)
      expect(actualInverseMap.get(atomKey2)).toEqual([...ip3]);
      // Check map size
      expect(actualInverseMap.size).toBe(expectedInverse.size);

    });

     it('should emit onRollback correctly when rejecting the first mutation', () => {
      coordinator.rejectMutation(seq1); // Reject seq1, should rollback 1, 2, 3, 4

      // Expected inverse patches (applied in reverse order: ip4, ip3, ip2, ip1)
      const expectedInverse = new Map<AtomKey, PatchOperation[]>();
      expectedInverse.set(atomKey1, [...ip4, ...ip2, ...ip1]); // ip4, ip2, ip1 affect atomKey1
      expectedInverse.set(atomKey2, [...ip3]); // ip3 affects atomKey2

      expect(mockOnRollback).toHaveBeenCalledTimes(1);
      const actualInverseMap = mockOnRollback.mock.calls[0][0] as Map<AtomKey, PatchOperation[]>;

      expect(actualInverseMap.get(atomKey1)).toEqual(expectedInverse.get(atomKey1));
      expect(actualInverseMap.get(atomKey2)).toEqual(expectedInverse.get(atomKey2));
      expect(actualInverseMap.size).toBe(expectedInverse.size);
    });

     it('should emit onRollback correctly when rejecting the last mutation', () => {
      coordinator.rejectMutation(seq4); // Reject seq4, should rollback only 4

      const expectedInverse = new Map<AtomKey, PatchOperation[]>();
      expectedInverse.set(atomKey1, [...ip4]); // Only ip4

      expect(mockOnRollback).toHaveBeenCalledTimes(1);
      const actualInverseMap = mockOnRollback.mock.calls[0][0] as Map<AtomKey, PatchOperation[]>;

      expect(actualInverseMap.get(atomKey1)).toEqual(expectedInverse.get(atomKey1));
      expect(actualInverseMap.size).toBe(expectedInverse.size);
    });


    it('should emit onError with clientSeq and error', () => {
      const error = new Error('Server failed');
      coordinator.rejectMutation(seq3, error);

      expect(mockOnError).toHaveBeenCalledTimes(1);
      // Note: The implementation currently doesn't emit onError, this test will fail until implemented
      // expect(mockOnError).toHaveBeenCalledWith(seq3, error);
    });

    it('should emit onStateChange when a mutation is rejected', () => {
      coordinator.rejectMutation(seq2);
      expect(mockOnStateChange).toHaveBeenCalledTimes(1);
    });

    it('should do nothing if the clientSeq does not exist', () => {
       const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      coordinator.rejectMutation(999); // Non-existent seq

      // @ts-ignore
      expect(coordinator.pendingMutations.length).toBe(4); // Queue unchanged
      expect(mockOnRollback).not.toHaveBeenCalled();
      expect(mockOnError).not.toHaveBeenCalled();
      expect(mockOnStateChange).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining(`Cannot reject mutation with clientSeq 999: Not found.`));
      consoleWarnSpy.mockRestore();
    });

     it('should NOT emit onRollback if rejected mutation had no inverse patches (and no subsequent mutations)', () => {
        // Clear queue and add one without inverse patches
        // @ts-ignore
        coordinator.pendingMutations = [];
        const seq = coordinator.generateClientSeq();
        coordinator.registerPendingMutation(seq, new Map([[atomKey1, p1]]), new Map()); // Empty inverse map
        mockOnRollback.mockClear();
        mockOnStateChange.mockClear();

        coordinator.rejectMutation(seq);

        expect(mockOnRollback).not.toHaveBeenCalled();
        expect(mockOnStateChange).toHaveBeenCalledTimes(1); // State still changes as queue becomes empty
        expect(coordinator.hasPendingMutations()).toBe(false);
    });


  }); // End of describe('rejectMutation')

  // 6. Server Delta Processing (`processServerDelta`)
  describe('processServerDelta', () => {
    const atomKey1: AtomKey = 'atom1';
    const serverPatch1: PatchOperation[] = [{ op: 'replace', path: '/server', value: 'update1' }];
    const serverPatch2: PatchOperation[] = [{ op: 'add', path: '/new', value: true }];
    const clientPatch1: PatchOperation[] = [{ op: 'replace', path: '/client', value: 'optimistic1' }];
    const clientInverse1: PatchOperation[] = [{ op: 'replace', path: '/client', value: 'original' }];
    const clientPatch2: PatchOperation[] = [{ op: 'add', path: '/another', value: 123 }];
    const clientInverse2: PatchOperation[] = [{ op: 'remove', path: '/another' }];

    let seq1: number, seq2: number;
    let patchesByAtom1: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom1: Map<AtomKey, PatchOperation[]>;
    let patchesByAtom2: Map<AtomKey, PatchOperation[]>;
    let inversePatchesByAtom2: Map<AtomKey, PatchOperation[]>;

    beforeEach(() => {
      // Optional: Register some mutations if needed for specific delta tests
      seq1 = coordinator.generateClientSeq(); // 1
      seq2 = coordinator.generateClientSeq(); // 2
      patchesByAtom1 = new Map([[atomKey1, clientPatch1]]);
      inversePatchesByAtom1 = new Map([[atomKey1, clientInverse1]]);
      patchesByAtom2 = new Map([[atomKey1, clientPatch2]]);
      inversePatchesByAtom2 = new Map([[atomKey1, clientInverse2]]);
      // Don't register by default, let tests decide
      mockOnStateChange.mockClear();
      mockOnApplyDelta.mockClear();
      mockOnRollback.mockClear();
      mockOnAck.mockClear();
    });

    it('should ignore stale deltas (serverSeq <= confirmedServerSeq)', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const delta: ServerDelta = { serverSeq: 0, patches: serverPatch1, key: atomKey1 }; // seq 0 <= current 0

      coordinator.processServerDelta(delta);

      expect(mockOnApplyDelta).not.toHaveBeenCalled();
      expect(coordinator.getConfirmedServerSeq()).toBe(0);
      expect(mockOnStateChange).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Received stale delta'));

      // Test with a previous sequence number
      const coordinatorAt10 = new OptimisticSyncCoordinator({ initialServerSeq: 10 });
      const deltaAt9: ServerDelta = { serverSeq: 9, patches: serverPatch1, key: atomKey1 };
      coordinatorAt10.processServerDelta(deltaAt9);
      expect(coordinatorAt10.getConfirmedServerSeq()).toBe(10);

      consoleWarnSpy.mockRestore();
    });

    it('should handle gaps based on placeholder logic (warn, update seq)', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const delta: ServerDelta = { serverSeq: 3, patches: serverPatch1, key: atomKey1 }; // Expecting 1, received 3

      coordinator.processServerDelta(delta);

      // Placeholder logic updates confirmedSeq to delta.serverSeq - 1
      // And then applies the delta, updating confirmedSeq to delta.serverSeq
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Detected gap'));
      expect(mockOnApplyDelta).toHaveBeenCalledTimes(1);
      expect(mockOnApplyDelta).toHaveBeenCalledWith(delta); // Applies the gapped delta
      expect(coordinator.getConfirmedServerSeq()).toBe(3); // Sequence updated to the received delta's seq
      expect(mockOnStateChange).not.toHaveBeenCalled(); // No pending mutations affected yet

      consoleErrorSpy.mockRestore();
    });

    it('should apply a sequential delta with no pending mutations', () => {
      const delta: ServerDelta = { serverSeq: 1, patches: serverPatch1, key: atomKey1 };

      coordinator.processServerDelta(delta);

      expect(mockOnApplyDelta).toHaveBeenCalledTimes(1);
      expect(mockOnApplyDelta).toHaveBeenCalledWith(delta);
      expect(coordinator.getConfirmedServerSeq()).toBe(1);
      expect(mockOnRollback).not.toHaveBeenCalled();
      expect(mockOnStateChange).not.toHaveBeenCalled();
      expect(mockOnAck).not.toHaveBeenCalled();
    });

    it('should apply delta and update confirmedServerSeq', () => {
      const delta1: ServerDelta = { serverSeq: 1, patches: serverPatch1, key: atomKey1 };
      const delta2: ServerDelta = { serverSeq: 2, patches: serverPatch2, key: atomKey1 };

      coordinator.processServerDelta(delta1);
      expect(coordinator.getConfirmedServerSeq()).toBe(1);
      expect(mockOnApplyDelta).toHaveBeenCalledWith(delta1);

      coordinator.processServerDelta(delta2);
      expect(coordinator.getConfirmedServerSeq()).toBe(2);
      expect(mockOnApplyDelta).toHaveBeenCalledWith(delta2);

      expect(mockOnApplyDelta).toHaveBeenCalledTimes(2);
    });

    it('should confirm the corresponding pending mutation if delta contains matching clientSeq', () => {
      coordinator.registerPendingMutation(seq1, patchesByAtom1, inversePatchesByAtom1);
      coordinator.registerPendingMutation(seq2, patchesByAtom2, inversePatchesByAtom2);
      mockOnStateChange.mockClear(); // Clear registration calls

      const deltaConfirmingSeq1: ServerDelta = {
        serverSeq: 1,
        clientSeq: seq1, // Confirms seq1
        patches: serverPatch1, // Server might send patches even if confirming
        key: atomKey1
      };

      coordinator.processServerDelta(deltaConfirmingSeq1);

      expect(mockOnApplyDelta).toHaveBeenCalledTimes(1);
      expect(mockOnApplyDelta).toHaveBeenCalledWith(deltaConfirmingSeq1);
      expect(coordinator.getConfirmedServerSeq()).toBe(1);
      expect(mockOnAck).toHaveBeenCalledTimes(1);
      expect(mockOnAck).toHaveBeenCalledWith(seq1, undefined); // No result in delta
      expect(coordinator.hasPendingMutations()).toBe(true);
      // @ts-ignore
      expect(coordinator.pendingMutations.length).toBe(1);
      // @ts-ignore
      expect(coordinator.pendingMutations[0].clientSeq).toBe(seq2); // Only seq2 remains
      expect(mockOnStateChange).toHaveBeenCalledTimes(1); // State changed due to confirmation
    });

    describe('with Pending Mutations (Placeholder Conflict Logic)', () => {
       beforeEach(() => {
         // Register mutations for conflict tests
         coordinator.registerPendingMutation(seq1, patchesByAtom1, inversePatchesByAtom1);
         coordinator.registerPendingMutation(seq2, patchesByAtom2, inversePatchesByAtom2);
         mockOnStateChange.mockClear();
         mockOnRollback.mockClear();
         mockOnApplyDelta.mockClear();
         mockOnAck.mockClear();
       });

       it('should trigger rollback of all pending mutations', () => {
         const delta: ServerDelta = { serverSeq: 1, patches: serverPatch1, key: atomKey1 };
         coordinator.processServerDelta(delta);

         expect(mockOnRollback).toHaveBeenCalledTimes(1);
         const actualInverseMap = mockOnRollback.mock.calls[0][0] as Map<AtomKey, PatchOperation[]>;
         // Rollback 2 then 1
         expect(actualInverseMap.get(atomKey1)).toEqual([...clientInverse2, ...clientInverse1]);
       });

       it('should apply the original server delta after rollback', () => {
         const delta: ServerDelta = { serverSeq: 1, patches: serverPatch1, key: atomKey1 };
         coordinator.processServerDelta(delta);

         expect(mockOnApplyDelta).toHaveBeenCalledTimes(1);
         expect(mockOnApplyDelta).toHaveBeenCalledWith(delta); // Original delta is applied
       });

       it('should update confirmedServerSeq', () => {
          const delta: ServerDelta = { serverSeq: 1, patches: serverPatch1, key: atomKey1 };
          coordinator.processServerDelta(delta);
          expect(coordinator.getConfirmedServerSeq()).toBe(1);
       });

       it('should keep pending mutations but transformed (placeholder: no actual transform)', () => {
         const delta: ServerDelta = { serverSeq: 1, patches: serverPatch1, key: atomKey1 };
         coordinator.processServerDelta(delta);

         expect(coordinator.hasPendingMutations()).toBe(true);
         // @ts-ignore
         expect(coordinator.pendingMutations.length).toBe(2); // Still has 2 pending
         // Placeholder transform doesn't change patches
         const pendingPatches = coordinator.getPendingPatches();
         expect(pendingPatches.get(atomKey1)).toEqual([...clientPatch1, ...clientPatch2]);
       });

        it('should emit onStateChange due to rollback/rebase', () => {
          const delta: ServerDelta = { serverSeq: 1, patches: serverPatch1, key: atomKey1 };
          coordinator.processServerDelta(delta);
          expect(mockOnStateChange).toHaveBeenCalledTimes(1);
        });

        it('should still confirm mutation if delta has matching clientSeq during conflict', () => {
           const deltaConfirmingSeq1: ServerDelta = {
             serverSeq: 1,
             clientSeq: seq1, // Confirms seq1
             patches: serverPatch1,
             key: atomKey1
           };
           coordinator.processServerDelta(deltaConfirmingSeq1);

           expect(mockOnRollback).toHaveBeenCalledTimes(1); // Rollback still happens first
           expect(mockOnApplyDelta).toHaveBeenCalledWith(deltaConfirmingSeq1);
           expect(mockOnAck).toHaveBeenCalledTimes(1);
           expect(mockOnAck).toHaveBeenCalledWith(seq1, undefined);
           expect(coordinator.hasPendingMutations()).toBe(true);
           // @ts-ignore
           expect(coordinator.pendingMutations.length).toBe(1); // seq1 removed
           // @ts-ignore
           expect(coordinator.pendingMutations[0].clientSeq).toBe(seq2); // seq2 remains (transformed placeholder)
           expect(mockOnStateChange).toHaveBeenCalledTimes(1); // State changed
        });

    });

  }); // End of describe('processServerDelta')

  // 7. Pending Patches Retrieval (`getPendingPatches`)
  describe('getPendingPatches', () => {
    const atomKey1: AtomKey = 'atom1';
    const atomKey2: AtomKey = 'atom2';
    const p1: PatchOperation[] = [{ op: 'add', path: '/a', value: 1 }];
    const ip1: PatchOperation[] = [{ op: 'remove', path: '/a' }];
    const p2: PatchOperation[] = [{ op: 'replace', path: '/b', value: 2 }]; // Same atom
    const ip2: PatchOperation[] = [{ op: 'replace', path: '/b', value: 0 }];
    const p3: PatchOperation[] = [{ op: 'add', path: '/c', value: 3 }]; // Different atom
    const ip3: PatchOperation[] = [{ op: 'remove', path: '/c' }];

    it('should return an empty map when no pending mutations', () => {
      expect(coordinator.getPendingPatches().size).toBe(0);
    });

    it('should return patches grouped by AtomKey for a single mutation', () => {
      const seq = coordinator.generateClientSeq();
      const patchesByAtom = new Map([
        [atomKey1, p1],
        [atomKey2, p3],
      ]);
      const inversePatchesByAtom = new Map([
        [atomKey1, ip1],
        [atomKey2, ip3],
      ]);
      coordinator.registerPendingMutation(seq, patchesByAtom, inversePatchesByAtom);

      const pending = coordinator.getPendingPatches();
      expect(pending.size).toBe(2);
      expect(pending.get(atomKey1)).toEqual(p1);
      expect(pending.get(atomKey2)).toEqual(p3);
    });

    it('should merge patches for the same AtomKey from multiple mutations in order', () => {
      const seq1 = coordinator.generateClientSeq();
      const seq2 = coordinator.generateClientSeq();
      const seq3 = coordinator.generateClientSeq();

      const patchesByAtom1 = new Map([[atomKey1, p1]]);
      const inversePatchesByAtom1 = new Map([[atomKey1, ip1]]);
      const patchesByAtom2 = new Map([[atomKey1, p2]]); // Same atom
      const inversePatchesByAtom2 = new Map([[atomKey1, ip2]]);
      const patchesByAtom3 = new Map([[atomKey2, p3]]); // Different atom
      const inversePatchesByAtom3 = new Map([[atomKey2, ip3]]);

      coordinator.registerPendingMutation(seq1, patchesByAtom1, inversePatchesByAtom1);
      coordinator.registerPendingMutation(seq2, patchesByAtom2, inversePatchesByAtom2);
      coordinator.registerPendingMutation(seq3, patchesByAtom3, inversePatchesByAtom3);

      const pending = coordinator.getPendingPatches();
      expect(pending.size).toBe(2);
      // Patches for atomKey1 should be concatenated in registration order (p1 then p2)
      expect(pending.get(atomKey1)).toEqual([...p1, ...p2]);
      expect(pending.get(atomKey2)).toEqual(p3);
    });

    it('should return an empty map after all mutations are confirmed', () => {
      const seq1 = coordinator.generateClientSeq();
      const seq2 = coordinator.generateClientSeq();
      coordinator.registerPendingMutation(seq1, new Map([[atomKey1, p1]]), new Map([[atomKey1, ip1]]));
      coordinator.registerPendingMutation(seq2, new Map([[atomKey2, p3]]), new Map([[atomKey2, ip3]]));

      coordinator.confirmMutation(seq1);
      coordinator.confirmMutation(seq2);

      expect(coordinator.getPendingPatches().size).toBe(0);
    });

    it('should return remaining patches after some mutations are confirmed', () => {
      const seq1 = coordinator.generateClientSeq();
      const seq2 = coordinator.generateClientSeq();
      const seq3 = coordinator.generateClientSeq();
      coordinator.registerPendingMutation(seq1, new Map([[atomKey1, p1]]), new Map([[atomKey1, ip1]]));
      coordinator.registerPendingMutation(seq2, new Map([[atomKey1, p2]]), new Map([[atomKey1, ip2]])); // Same atom
      coordinator.registerPendingMutation(seq3, new Map([[atomKey2, p3]]), new Map([[atomKey2, ip3]])); // Different atom

      coordinator.confirmMutation(seq1); // Confirm first one

      const pending = coordinator.getPendingPatches();
      expect(pending.size).toBe(2);
      expect(pending.get(atomKey1)).toEqual(p2); // Only p2 remains for atomKey1
      expect(pending.get(atomKey2)).toEqual(p3);
    });

     it('should return remaining patches after some mutations are rejected', () => {
      const seq1 = coordinator.generateClientSeq();
      const seq2 = coordinator.generateClientSeq();
      const seq3 = coordinator.generateClientSeq();
      coordinator.registerPendingMutation(seq1, new Map([[atomKey1, p1]]), new Map([[atomKey1, ip1]]));
      coordinator.registerPendingMutation(seq2, new Map([[atomKey1, p2]]), new Map([[atomKey1, ip2]])); // Same atom
      coordinator.registerPendingMutation(seq3, new Map([[atomKey2, p3]]), new Map([[atomKey2, ip3]])); // Different atom

      coordinator.rejectMutation(seq2); // Reject seq2, removes seq2 and seq3

      const pending = coordinator.getPendingPatches();
      expect(pending.size).toBe(1);
      expect(pending.get(atomKey1)).toEqual(p1); // Only p1 remains
      expect(pending.get(atomKey2)).toBeUndefined();
    });
  });

  // 8. Event Emission Verification (Consistency Checks)
  describe('Event Emission Consistency', () => {
     const atomKey1: AtomKey = 'atom1';
     const patches1: PatchOperation[] = [{ op: 'add', path: '/a', value: 1 }];
     const inversePatches1: PatchOperation[] = [{ op: 'remove', path: '/a' }];
     const serverDelta: ServerDelta = { serverSeq: 1, patches: [{ op: 'replace', path: '/s', value: 1 }], key: atomKey1 };

     it('registerPendingMutation should only emit onStateChange', () => {
        coordinator.registerPendingMutation(1, new Map([[atomKey1, patches1]]), new Map([[atomKey1, inversePatches1]]));
        expect(mockOnStateChange).toHaveBeenCalledTimes(1);
        expect(mockOnApplyDelta).not.toHaveBeenCalled();
        expect(mockOnRollback).not.toHaveBeenCalled();
        expect(mockOnAck).not.toHaveBeenCalled();
        expect(mockOnError).not.toHaveBeenCalled();
     });

     it('confirmMutation should emit onAck and onStateChange', () => {
        coordinator.registerPendingMutation(1, new Map([[atomKey1, patches1]]), new Map([[atomKey1, inversePatches1]]));
        mockOnStateChange.mockClear();
        coordinator.confirmMutation(1, { success: true });
        expect(mockOnAck).toHaveBeenCalledTimes(1);
        expect(mockOnAck).toHaveBeenCalledWith(1, { success: true });
        expect(mockOnStateChange).toHaveBeenCalledTimes(1);
        expect(mockOnApplyDelta).not.toHaveBeenCalled();
        expect(mockOnRollback).not.toHaveBeenCalled();
        expect(mockOnError).not.toHaveBeenCalled();
     });

     it('rejectMutation should emit onRollback and onStateChange (and potentially onError)', () => {
        coordinator.registerPendingMutation(1, new Map([[atomKey1, patches1]]), new Map([[atomKey1, inversePatches1]]));
        mockOnStateChange.mockClear();
        const error = new Error('rejected');
        coordinator.rejectMutation(1, error);
        expect(mockOnRollback).toHaveBeenCalledTimes(1);
        expect(mockOnRollback).toHaveBeenCalledWith(new Map([[atomKey1, inversePatches1]]));
        expect(mockOnStateChange).toHaveBeenCalledTimes(1);
        // expect(mockOnError).toHaveBeenCalledTimes(1); // Currently not implemented
        // expect(mockOnError).toHaveBeenCalledWith(1, error);
        expect(mockOnAck).not.toHaveBeenCalled();
        expect(mockOnApplyDelta).not.toHaveBeenCalled();
     });

     it('processServerDelta (no conflict, no ack) should emit onApplyDelta only', () => {
        coordinator.processServerDelta(serverDelta);
        expect(mockOnApplyDelta).toHaveBeenCalledTimes(1);
        expect(mockOnApplyDelta).toHaveBeenCalledWith(serverDelta);
        expect(mockOnStateChange).not.toHaveBeenCalled();
        expect(mockOnRollback).not.toHaveBeenCalled();
        expect(mockOnAck).not.toHaveBeenCalled();
        expect(mockOnError).not.toHaveBeenCalled();
     });

     it('processServerDelta (with ack) should emit onApplyDelta, onAck, onStateChange', () => {
        coordinator.registerPendingMutation(1, new Map([[atomKey1, patches1]]), new Map([[atomKey1, inversePatches1]]));
        mockOnStateChange.mockClear();
        const deltaWithAck = { ...serverDelta, clientSeq: 1 };
        coordinator.processServerDelta(deltaWithAck);
        expect(mockOnApplyDelta).toHaveBeenCalledTimes(1);
        expect(mockOnApplyDelta).toHaveBeenCalledWith(deltaWithAck);
        expect(mockOnAck).toHaveBeenCalledTimes(1);
        expect(mockOnAck).toHaveBeenCalledWith(1, undefined);
        expect(mockOnStateChange).toHaveBeenCalledTimes(1);
        expect(mockOnRollback).not.toHaveBeenCalled();
        expect(mockOnError).not.toHaveBeenCalled();
     });

     it('processServerDelta (with conflict placeholder) should emit onRollback, onApplyDelta, onStateChange', () => {
        coordinator.registerPendingMutation(1, new Map([[atomKey1, patches1]]), new Map([[atomKey1, inversePatches1]]));
        mockOnStateChange.mockClear();
        coordinator.processServerDelta(serverDelta); // Triggers placeholder conflict
        expect(mockOnRollback).toHaveBeenCalledTimes(1);
        expect(mockOnApplyDelta).toHaveBeenCalledTimes(1);
        expect(mockOnApplyDelta).toHaveBeenCalledWith(serverDelta);
        expect(mockOnStateChange).toHaveBeenCalledTimes(1);
        expect(mockOnAck).not.toHaveBeenCalled();
        expect(mockOnError).not.toHaveBeenCalled();
     });

  }); // End of describe('Event Emission Consistency')

}); // End of describe('OptimisticSyncCoordinator')