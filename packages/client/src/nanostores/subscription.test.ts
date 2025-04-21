import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import { map, atom, type MapStore, type Atom, onMount, task, type ReadableAtom, type Store } from 'nanostores';
// Import both patch types
import type { Patch } from 'immer';
import { applyPatch, type Operation } from 'fast-json-patch';

// Import ProcedureClientPathSelector from query.ts
import { subscription, type SubscriptionOptions, type SubscriptionAtom, type SubscriptionAtomState, type SubscriptionStatus } from './subscription'; // Function under test
import { type ProcedureClientPathSelector } from './query'; // Import selector type
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta, CoordinatorEvents } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
// Keep applyImmerPatches for rollback
import { applyImmerPatches } from './patchUtils';
// Remove applyJsonDelta
// import { applyJsonDelta } from './stateUtils';

// Remove local PatchOperation definition

// --- Mocks ---

// Mock Coordinator (Keep as is)
vi.mock('../coordinator', async () => {
    const actualCoordinator = await vi.importActual('../coordinator') as { OptimisticSyncCoordinator: typeof OptimisticSyncCoordinator };
    const mockEmitter = {
        events: {} as Record<keyof CoordinatorEvents, Function[]>,
        on: vi.fn((event: keyof CoordinatorEvents, cb: Function) => {
            if (!mockEmitter.events[event]) mockEmitter.events[event] = [];
            mockEmitter.events[event].push(cb);
            const unsub = vi.fn(() => {
                mockEmitter.events[event] = mockEmitter.events[event]?.filter(f => f !== cb);
            });
            return unsub;
        }),
        emit: vi.fn((event: keyof CoordinatorEvents, ...args: any[]) => {
            mockEmitter.events[event]?.forEach(cb => cb(...args));
        }),
        clearListeners: () => { mockEmitter.events = {} as Record<keyof CoordinatorEvents, Function[]>; }
    };
    const MockCoordinator = vi.fn().mockImplementation(() => {
        const instance = {
            on: mockEmitter.on,
            // Return Operation[] for pending patches
            getPendingPatches: vi.fn(() => new Map<AtomKey, Operation[]>()),
            __mockEmit: mockEmitter.emit,
            __mockClearListeners: mockEmitter.clearListeners,
        };
        return instance as any;
    });
    return { OptimisticSyncCoordinator: MockCoordinator };
});

// Mock Client (Keep subscription mock)
const mockSubscribeProcedure = vi.fn();
const mockClient = {
    subscription: { // Mock subscription procedures
        posts: {
            updates: {
                subscribe: mockSubscribeProcedure,
            },
        },
    },
    getCoordinator: vi.fn(),
} as unknown as ZenQueryClient;

// Mock Atom Registry (Keep as is)
vi.mock('../utils/atomRegistry', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        generateAtomKey: vi.fn((path, input) => JSON.stringify({ path, input })),
        registerAtom: vi.fn(),
        unregisterAtom: vi.fn(),
        getAtom: vi.fn(),
    };
});

// Mock Patch Utils (Keep as is)
vi.mock('./patchUtils', () => ({
    applyImmerPatches: vi.fn((base, patches) => {
        console.log('[Mock applyImmerPatches] Applying:', patches, 'to base:', base);
        if (patches.length > 0 && typeof base === 'object' && base !== null) {
            return { ...base, __appliedOptimistic: true };
        }
        return base;
    }),
}));

// Mock fast-json-patch (similar to query.test.ts)
vi.mock('fast-json-patch', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        applyPatch: vi.fn((base, patches) => {
            console.log('[Mock applyPatch] Applying:', patches, 'to base:', base);
            const newDoc = structuredClone(base);
            if (patches.length > 0 && typeof newDoc === 'object' && newDoc !== null) {
                 newDoc.__appliedPatch = true; // Use generic marker
            }
            // Cast return to 'any' to bypass potential mock type inference issues
            return { newDocument: newDoc } as any;
        }),
    };
});

// Remove mock for stateUtils
// vi.mock('./stateUtils', () => ({ ... }));

// Remove Nanostores mock entirely - let tests use actual implementation
// vi.mock('nanostores', async (importOriginal) => { ... });

// --- Test Suite ---

describe('Nanostores subscription() helper', () => {
    let mockCoordinatorInstance: OptimisticSyncCoordinator;
    let capturedUnmount: (() => void) | void | undefined;
    let mockClientUnsubscribe: Mock; // Keep this
    let mockClientAtom: ReadableAtom<ZenQueryClient>; // Add mock client atom
    let subscribeCallbacks: any; // Declare in higher scope
    let mockApplyPatch: Mock; // Declare mock function in higher scope

    // Helper to simulate mounting (Keep as is)
    const simulateMount = (atomInstance: Atom<any>) => {
        const instanceWithMocks = atomInstance as any;
        if (instanceWithMocks.__mockMountCallbacks && instanceWithMocks.__mockMountCallbacks.length > 0) {
            const initialize = instanceWithMocks.__mockMountCallbacks[instanceWithMocks.__mockMountCallbacks.length - 1];
            if (typeof initialize === 'function') {
                const unmountFn = initialize();
                if (typeof unmountFn === 'function') {
                    instanceWithMocks.__mockUnmount = unmountFn;
                }
            }
        }
    };

    // Helper to simulate unmounting (Keep as is)
    const simulateUnmount = (atomInstance: Atom<any>) => {
        const instanceWithMocks = atomInstance as any;
        if (typeof instanceWithMocks.__mockUnmount === 'function') {
            instanceWithMocks.__mockUnmount();
            instanceWithMocks.__mockUnmount = undefined;
        }
    };

    beforeEach(async () => { // Keep async for imports
        vi.clearAllMocks();

        // Move mock assignment here
        const fastJsonPatch = await import('fast-json-patch');
        mockApplyPatch = vi.mocked(fastJsonPatch.applyPatch);

        const { OptimisticSyncCoordinator: MockCoordinator } = await import('../coordinator');
        mockCoordinatorInstance = new MockCoordinator();
        (mockCoordinatorInstance as any).__mockClearListeners?.();
        vi.mocked(mockClient.getCoordinator).mockReturnValue(mockCoordinatorInstance as any);

        // Create and store the mock client atom
        mockClientAtom = atom(mockClient);

        // No need to register 'zenQueryClient' globally anymore

        mockClientUnsubscribe = vi.fn();
        mockSubscribeProcedure.mockReset().mockReturnValue({ unsubscribe: mockClientUnsubscribe });

        vi.mocked(generateAtomKey).mockClear();
        // vi.mocked(registerAtom).mockClear(); // REMOVE - Interferes with mock implementation
        vi.mocked(unregisterAtom).mockClear();
        // vi.mocked(getAtom).mockClear(); // REMOVE - Interferes with mock implementation
        vi.mocked(applyImmerPatches).mockClear();
        mockApplyPatch.mockClear(); // Clear the mock function
        // Remove applyJsonDelta mock clear
        // vi.mocked(applyJsonDelta).mockClear();
        // Remove mockClear for Nanostores functions
        // vi.mocked(onMount).mockClear();
        // vi.mocked(task).mockClear();
        capturedUnmount = undefined;
        subscribeCallbacks = undefined; // Reset callbacks
    });

    afterEach(() => {
        // Keep cleanup
    });

    // Remove clientGetter
    const defaultPath = 'posts.updates';
    const defaultInput = { postId: '456' };
    // Update defaultOptions: remove path
    const defaultOptions: SubscriptionOptions<typeof defaultInput, { id: string; content: string; version: number }> = {
        input: defaultInput,
        // path: defaultPath, // REMOVED
    };
    const defaultAtomKey = JSON.stringify({ path: defaultPath, input: defaultInput });

    // Update mock selector to accept client instance
    const mockProcedureSelector: ProcedureClientPathSelector<{ subscribe: Mock }> = (
        client: ZenQueryClient // Accept client
    ) => {
        // Use the passed client (or mock directly if simpler)
        const procedure = {
            subscribe: mockSubscribeProcedure
        };
        return {
            path: defaultPath, // Path string
            procedure: procedure, // Procedure object containing the method
            _isZenQueryProcedure: true // Marker
        };
    };
  
  
    // --- Test Cases ---

    it('should initialize with correct default state (enabled: true)', () => {
        // Update subscription call: Pass mockClientAtom
        const subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
        simulateMount(subAtom); // Add mount simulation
        const initialState = subAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.status).toBe('connecting'); // Should be connecting after mount
        expect(initialState.error).toBeNull();
        expect(vi.mocked(generateAtomKey)).toHaveBeenCalledWith(defaultPath, defaultInput);
        expect(subAtom.key).toBe(defaultAtomKey);
    });

     it('should initialize with initialData', () => {
        const initialData = { id: '456', content: 'Initial Content', version: 0 };
        // Update subscription call: Pass mockClientAtom
        const subAtom = subscription(mockClientAtom, mockProcedureSelector, { ...defaultOptions, initialData });
        simulateMount(subAtom); // Add mount simulation
        const initialState = subAtom.get();

        expect(initialState.data).toEqual(initialData);
        expect(initialState.status).toBe('connecting'); // Should be connecting after mount
        expect(initialState.error).toBeNull();
    });

    it('should initialize with correct default state (enabled: false)', () => {
        // Update subscription call: Pass mockClientAtom
        const subAtom = subscription(mockClientAtom, mockProcedureSelector, { ...defaultOptions, enabled: false });
        simulateMount(subAtom); // Add mount simulation
        const initialState = subAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.status).toBe('idle'); // Remains idle if not enabled
        expect(initialState.error).toBeNull();
    });

    describe('onMount', () => {
        it('should register the atom with the registry', () => {
            // Update subscription call: Pass mockClientAtom
            const subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);

            // Check for the first call (only subscription atom is registered)
            expect(vi.mocked(registerAtom)).toHaveBeenCalledTimes(2);
            expect(vi.mocked(registerAtom).mock.calls[1]).toEqual([defaultAtomKey, subAtom]);
        });

        it('should subscribe to coordinator events (onStateChange, onApplyDelta, onRollback)', () => {
            // Update subscription call: Pass mockClientAtom
            const subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);

            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onStateChange', expect.any(Function));
            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onApplyDelta', expect.any(Function));
            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onRollback', expect.any(Function));
        });

        it('should call client.subscribe and set status to connecting/connected if enabled', () => {
            // Update subscription call: Pass mockClientAtom
            const subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);

            expect(subAtom.get().status).toBe('connecting');
            expect(mockSubscribeProcedure).toHaveBeenCalledTimes(1);
            expect(mockSubscribeProcedure).toHaveBeenCalledWith(defaultInput, expect.objectContaining({
                onData: expect.any(Function),
                onError: expect.any(Function),
                onComplete: expect.any(Function),
            }));

             expect(subAtom.get().status).toBe('connected');
        });

        it('should NOT call client.subscribe if enabled: false', () => {
            // Update subscription call: Pass mockClientAtom
            const subAtom = subscription(mockClientAtom, mockProcedureSelector, { ...defaultOptions, enabled: false });
            simulateMount(subAtom);

            expect(mockSubscribeProcedure).not.toHaveBeenCalled();
            expect(subAtom.get().status).toBe('idle');
        });

        it('should handle error during client.subscribe call', () => {
            const subscribeError = new Error('Connection Refused');
            mockSubscribeProcedure.mockImplementation(() => { throw subscribeError; });

            // Update subscription call: Pass mockClientAtom
            const subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);

            expect(mockSubscribeProcedure).toHaveBeenCalledTimes(1);
            expect(subAtom.get().status).toBe('error');
            expect(subAtom.get().error).toBe(subscribeError);
        });

        it('should unregister atom, unsubscribe from coordinator, and call client unsubscribe on unmount', () => {
            const mockUnsubChange = vi.fn();
            const mockUnsubDelta = vi.fn();
            const mockUnsubRollback = vi.fn();
            vi.mocked(mockCoordinatorInstance.on)
                .mockImplementationOnce((event, cb) => mockUnsubChange)    // onStateChange
                .mockImplementationOnce((event, cb) => mockUnsubDelta)     // onApplyDelta
                .mockImplementationOnce((event, cb) => mockUnsubRollback); // onRollback

           // Update subscription call: Pass mockClientAtom
           const subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
           simulateMount(subAtom);
           expect(mockSubscribeProcedure).toHaveBeenCalledTimes(1);

            simulateUnmount(subAtom);

            expect(vi.mocked(unregisterAtom)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(unregisterAtom)).toHaveBeenCalledWith(defaultAtomKey);
            expect(mockUnsubChange).toHaveBeenCalledTimes(1);
            expect(mockUnsubDelta).toHaveBeenCalledTimes(1);
            expect(mockUnsubRollback).toHaveBeenCalledTimes(1);
            expect(mockClientUnsubscribe).toHaveBeenCalledTimes(1);
        });
    });

    describe('onData Handling', () => {
        let subAtom: SubscriptionAtom<any, any>;
        // let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function }; // Moved to higher scope

        beforeEach(async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            // Update subscription call: Pass mockClientAtom
            subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);

            expect(mockSubscribeProcedure).toHaveBeenCalledTimes(1);
            expect(subscribeCallbacks).toBeDefined();
            expect(subAtom.get().status).toBe('connected');
            // Clear applyPatch mock (already assigned in beforeEach)
            mockApplyPatch.mockClear();
            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply full snapshot data via onData', () => {
            const snapshotData = { id: '456', content: 'Full Snapshot', version: 1 };

            subscribeCallbacks.onData(snapshotData);

            // Check applyPatch mock (called by computeOptimisticState after snapshot)
            // Use mockApplyPatch defined in beforeEach
            expect(mockApplyPatch).toHaveBeenCalledTimes(1);
            expect(mockApplyPatch).toHaveBeenCalledWith(expect.objectContaining(snapshotData), [], true, false); // No pending patches

            expect(subAtom.get().data).toEqual({ ...snapshotData, __appliedPatch: true }); // Updated based on applyPatch mock
            expect(subAtom.get().status).toBe('connected');
            expect(subAtom.get().error).toBeNull();
        });

        it('should apply delta patches via onData', () => {
            const initialSnapshot = { id: '456', content: 'Initial', version: 1 };
            const deltaPatches: Operation[] = [{ op: 'replace', path: '/content', value: 'Delta Update' }, { op: 'add', path: '/newField', value: true }];
            // Update expected data based on applyPatch mock
            const expectedDataAfterDelta = { ...initialSnapshot, content: 'Delta Update', newField: true, __appliedPatch: true };
            const expectedOptimisticData = { ...expectedDataAfterDelta, __appliedPatch: true }; // applyPatch mock used for both

            subscribeCallbacks.onData(initialSnapshot); // Set initial confirmed data
            // Use mockApplyPatch defined in beforeEach
            mockApplyPatch.mockClear(); // Clear calls from initial snapshot
            vi.mocked(applyImmerPatches).mockClear();

            subscribeCallbacks.onData(deltaPatches);

            // Check applyPatch mock (called twice: once for delta, once for optimistic recompute)
            // Use mockApplyPatch defined in beforeEach
            expect(mockApplyPatch).toHaveBeenCalledTimes(2);
            // First call applies the delta to initialSnapshot
            expect(mockApplyPatch).toHaveBeenNthCalledWith(1, expect.objectContaining(initialSnapshot), deltaPatches, true, false);
            // Second call recomputes optimistic state (base is now delta-applied data, patches are [])
            expect(mockApplyPatch).toHaveBeenNthCalledWith(2, expect.objectContaining(expectedDataAfterDelta), [], true, false);

            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected');
            expect(subAtom.get().error).toBeNull();
        });

         it('should update status from connecting to connected on first data', async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });
            // Update subscription call: Pass mockClientAtom
            subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);
            expect(subAtom.get().status).toBe('connecting'); // Should be connecting initially

            const snapshotData = { id: '456', content: 'First Data', version: 1 };
            subscribeCallbacks.onData(snapshotData);

            expect(subAtom.get().status).toBe('connected');
        });

    });

    describe('Client Callback Handling (onError, onComplete)', () => {
        let subAtom: SubscriptionAtom<any, any>;
        // let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function }; // Moved to higher scope

        beforeEach(async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            // Update subscription call: Pass mockClientAtom
            subAtom = subscription(mockClientAtom, mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);
            // Assume connection happens quickly in test setup
            if (subscribeCallbacks) subscribeCallbacks.onData({}); // Simulate initial data to move to 'connected'
            expect(subAtom.get().status).toBe('connected');
        });

        it('should set error status and store error on onError callback', () => {
            const clientError = new Error('Subscription Lost');

            subscribeCallbacks.onError(clientError);

            expect(subAtom.get().status).toBe('error');
            expect(subAtom.get().error).toBe(clientError);
            expect(mockClientUnsubscribe).toHaveBeenCalledTimes(1);
        });

        it('should set status to closed on onComplete callback', () => {
            subscribeCallbacks.onComplete();

            expect(subAtom.get().status).toBe('closed');
            expect(subAtom.get().error).toBeNull();
            expect(mockClientUnsubscribe).toHaveBeenCalledTimes(1);
        });

        it('should ignore callbacks if unmounted', () => {
             const clientError = new Error('Subscription Lost');
             const snapshotData = { id: '456', content: 'Late Data', version: 2 };

             simulateUnmount(subAtom);

             subscribeCallbacks.onError(clientError);
             subscribeCallbacks.onComplete();
             subscribeCallbacks.onData(snapshotData);

             expect(subAtom.get().status).toBe('closed');
             expect(subAtom.get().error).toBeNull();
             expect(subAtom.get().data).toBeUndefined();
        });
    });

    describe('Optimistic Updates (onStateChange)', () => {
        let subAtom: SubscriptionAtom<any, any>;
        // let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function }; // Moved to higher scope
        const initialData = { id: '456', content: 'Initial', version: 1 };
        // Use Operation format for optimistic patches
        const optimisticPatch: Operation[] = [{ op: 'replace', path: '/content', value: 'Optimistic Content' }];
        // Update expected data based on applyPatch mock
        const expectedOptimisticData = { ...initialData, __appliedPatch: true };

        beforeEach(async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            // Update subscription call: Pass mockClientAtom
            subAtom = subscription(mockClientAtom, mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(subAtom);
            // Assume connection happens quickly in test setup
            if (subscribeCallbacks) subscribeCallbacks.onData(initialData); // Simulate initial data to move to 'connected'
            expect(subAtom.get().status).toBe('connected');

            // Use mockApplyPatch defined in beforeEach
            mockApplyPatch.mockClear(); // Clear calls from initial data
            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply pending patches from coordinator on onStateChange', () => {
            const pendingPatchesMap = new Map<AtomKey, Operation[]>(); // Use Operation[]
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            // Check applyPatch mock
            // Use mockApplyPatch defined in beforeEach
            expect(mockApplyPatch).toHaveBeenCalledTimes(1);
            expect(mockApplyPatch).toHaveBeenCalledWith(expect.objectContaining(initialData), optimisticPatch, true, false);

            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected');
        });

        it('should do nothing if no pending patches for this atom', () => {
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => new Map());

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            // Use mockApplyPatch assigned in beforeEach
            expect(mockApplyPatch).not.toHaveBeenCalled();
            // Data remains initial data (applyPatch mock adds flag only if patches exist)
            expect(subAtom.get().data).toEqual(initialData);
        });

        it('should handle errors during optimistic patch application', () => {
            const patchError = new Error('Optimistic Patch failed');
            // Use mockApplyPatch defined in beforeEach
            mockApplyPatch.mockImplementation(() => { throw patchError; });

            const pendingPatchesMap = new Map<AtomKey, Operation[]>(); // Use Operation[]
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(mockApplyPatch).toHaveBeenCalledTimes(1);
            expect(subAtom.get().status).toBe('error');
            expect(subAtom.get().error).toBe(patchError);
            expect(subAtom.get().data).toEqual(initialData);
        });
    });

    describe('Coordinator Event Handling (onApplyDelta, onRollback)', () => {
        let subAtom: SubscriptionAtom<any, any>;
        const initialData = { id: '456', content: 'Initial', version: 1 };

        beforeEach(async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => { // Ensure callbacks are captured
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            // Update subscription call: Pass mockClientAtom
            subAtom = subscription(mockClientAtom, mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(subAtom);
            // Assume connection happens quickly in test setup
            if (subscribeCallbacks) subscribeCallbacks.onData(initialData); // Simulate initial data to move to 'connected'
            expect(subAtom.get().status).toBe('connected');

            // Use mockApplyPatch defined in beforeEach
            mockApplyPatch.mockClear(); // Clear calls from initial data
            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply delta patches from coordinator via onApplyDelta', () => {
            const coordDeltaPatch: Operation[] = [{ op: 'replace', path: '/content', value: 'Coordinator Delta' }]; // Use imported Operation type
            const expectedDataAfterDelta = { ...initialData, content: 'Coordinator Delta', __appliedDelta: true };
            const expectedOptimisticData = { ...expectedDataAfterDelta, __appliedOptimistic: true };

            const serverDelta: ServerDelta = { serverSeq: 2, key: defaultAtomKey, patches: coordDeltaPatch };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            // Check applyPatch mock (called twice: once for delta, once for optimistic recompute)
            // Use mockApplyPatch defined in beforeEach
            expect(mockApplyPatch).toHaveBeenCalledTimes(2);
            // First call applies the delta to initialData
            expect(mockApplyPatch).toHaveBeenNthCalledWith(1, expect.objectContaining(initialData), coordDeltaPatch, true, false);
            // Second call recomputes optimistic state (base is now delta-applied data, patches are [])
            expect(mockApplyPatch).toHaveBeenNthCalledWith(2, expect.objectContaining(expectedDataAfterDelta), [], true, false);

            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected');
        });

        it('should ignore coordinator deltas for different atom keys', () => {
            const serverDelta: ServerDelta = { serverSeq: 2, key: 'other/key', patches: [{ op: 'add', path: '/foo', value: 1 }] as Operation[] }; // Cast patches to Operation[]
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            // Use mockApplyPatch defined in beforeEach
            expect(mockApplyPatch).not.toHaveBeenCalled();
            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled();
            expect(subAtom.get().data).toEqual(initialData);
        });

        it('should apply inverse Immer patches from coordinator via onRollback', () => {
            const optimisticStateBeforeRollback = { ...initialData, content: 'Optimistic', __appliedOptimistic: true };
            subAtom.get().data = optimisticStateBeforeRollback;

            const inversePatch: Patch[] = [{ op: 'replace', path: ['content'], value: 'Initial' }];
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set(defaultAtomKey, inversePatch);

            const rolledBackState = { ...initialData }; // Expected state after inverse applied
            // Mock applyImmerPatches for the rollback step
            vi.mocked(applyImmerPatches).mockReturnValueOnce(rolledBackState);
            // Mock applyPatch for the subsequent computeOptimisticState call
            // Use mockApplyPatch defined in beforeEach
            mockApplyPatch.mockReturnValueOnce({ newDocument: rolledBackState } as any); // Recompute results in rolledBackState

            (mockCoordinatorInstance as any).__mockEmit('onRollback', rollbackMap);

            // Check applyImmerPatches called by rollback handler
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(optimisticStateBeforeRollback, inversePatch);

            // Check applyPatch called by computeOptimisticState after rollback
            expect(mockApplyPatch).toHaveBeenCalledTimes(1);
            expect(mockApplyPatch).toHaveBeenCalledWith(expect.objectContaining(rolledBackState), [], true, false); // No pending patches

            expect(subAtom.get().data).toEqual(rolledBackState); // Final state after recompute
            expect(subAtom.get().status).toBe('connected');
            expect(subAtom.get().error).toBeNull();
        });

         it('should ignore coordinator rollbacks for different atom keys', () => {
            const inversePatch: Patch[] = [{ op: 'replace', path: ['content'], value: 'Initial' }];
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set('other/key', inversePatch);

            (mockCoordinatorInstance as any).__mockEmit('onRollback', rollbackMap);

            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled();
            expect(subAtom.get().data).toEqual(initialData);
        });

        it('should handle errors during rollback patch application', () => {
            const rollbackError = new Error('Rollback failed');
            vi.mocked(applyImmerPatches).mockImplementation(() => { throw rollbackError; });

            const inversePatch: Patch[] = [{ op: 'replace', path: ['content'], value: 'Initial' }];
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set(defaultAtomKey, inversePatch);

            (mockCoordinatorInstance as any).__mockEmit('onRollback', rollbackMap);

            expect(subAtom.get().status).toBe('error');
            expect(subAtom.get().error).toBe(rollbackError);
            expect(subAtom.get().data).toEqual(initialData); // Fallback to confirmed state before error
        });

    });

});