import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import { map, atom, type MapStore, type Atom, onMount, task, type ReadableAtom, type Store } from 'nanostores';
import type { Patch } from 'immer';
// import type { Operation as PatchOperation } from 'fast-json-patch'; // Replaced with local interface

// Import ProcedureClientPathSelector from query.ts
import { subscription, type SubscriptionOptions, type SubscriptionAtom, type SubscriptionAtomState, type SubscriptionStatus } from './subscription'; // Function under test
import { type ProcedureClientPathSelector } from './query'; // Import selector type
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta, CoordinatorEvents } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches } from './patchUtils';
import { applyJsonDelta } from './stateUtils';

// Local definition as workaround for import issues
interface PatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: any;
  from?: string;
}

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
            getPendingPatches: vi.fn(() => new Map<AtomKey, Patch[]>()),
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

// Mock State Utils (Keep as is)
vi.mock('./stateUtils', () => ({
    applyJsonDelta: vi.fn((base, patches) => {
        console.log('[Mock applyJsonDelta] Applying:', patches, 'to base:', base);
        if (patches.length > 0 && typeof base === 'object' && base !== null) {
            return { ...base, __appliedDelta: true };
        }
        return base;
    }),
}));

// Mock nanostores (Keep as is)
vi.mock('nanostores', async (importOriginal) => {
    const actual = await importOriginal() as typeof import('nanostores');
    return {
        ...actual,
        task: vi.fn((fn) => fn),
        onMount: vi.fn((store: import('nanostores').Store, initialize?: () => void | (() => void)) => {
            const storeWithMocks = store as any;
            if (!storeWithMocks.__mockMountCallbacks) storeWithMocks.__mockMountCallbacks = [];
            storeWithMocks.__mockMountCallbacks.push(initialize);
            return () => {};
        }),
    };
});

// --- Test Suite ---

describe('Nanostores subscription() helper', () => {
    // Remove clientAtom, clientGetter
    let mockCoordinatorInstance: OptimisticSyncCoordinator;
    let capturedUnmount: (() => void) | void | undefined;
    let mockClientUnsubscribe: Mock; // Keep this

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

    beforeEach(async () => {
        vi.clearAllMocks();

        const { OptimisticSyncCoordinator: MockCoordinator } = await import('../coordinator');
        mockCoordinatorInstance = new MockCoordinator();
        (mockCoordinatorInstance as any).__mockClearListeners?.();
        vi.mocked(mockClient.getCoordinator).mockReturnValue(mockCoordinatorInstance as any);

        // Remove clientAtom creation

        mockClientUnsubscribe = vi.fn();
        mockSubscribeProcedure.mockReset().mockReturnValue({ unsubscribe: mockClientUnsubscribe });

        vi.mocked(generateAtomKey).mockClear();
        vi.mocked(registerAtom).mockClear();
        vi.mocked(unregisterAtom).mockClear();
        vi.mocked(getAtom).mockClear();
        vi.mocked(applyImmerPatches).mockClear();
        vi.mocked(applyJsonDelta).mockClear();
        vi.mocked(onMount).mockClear();
        vi.mocked(task).mockClear();
        capturedUnmount = undefined;
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

    // Define mock procedure selector for subscription
    const mockProcedureSelector: ProcedureClientPathSelector<ZenQueryClient, { subscribe: Mock }> = (
        get: <TValue>(atom: ReadableAtom<TValue> | Store<TValue>) => TValue
    ) => ({
        client: mockClient,
        procedure: (mockClient.subscription.posts as any).updates, // Use 'as any' workaround
        path: defaultPath,
    });


    // --- Test Cases ---

    it('should initialize with correct default state (enabled: true)', () => {
        // Update subscription call
        const subAtom = subscription(mockProcedureSelector, defaultOptions);
        const initialState = subAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.status).toBe('idle');
        expect(initialState.error).toBeNull();
        expect(vi.mocked(generateAtomKey)).toHaveBeenCalledWith(defaultPath, defaultInput);
        expect(subAtom.key).toBe(defaultAtomKey);
    });

     it('should initialize with initialData', () => {
        const initialData = { id: '456', content: 'Initial Content', version: 0 };
        // Update subscription call
        const subAtom = subscription(mockProcedureSelector, { ...defaultOptions, initialData });
        const initialState = subAtom.get();

        expect(initialState.data).toEqual(initialData);
        expect(initialState.status).toBe('idle');
        expect(initialState.error).toBeNull();
    });

    it('should initialize with correct default state (enabled: false)', () => {
        // Update subscription call
        const subAtom = subscription(mockProcedureSelector, { ...defaultOptions, enabled: false });
        const initialState = subAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.status).toBe('idle');
        expect(initialState.error).toBeNull();
    });

    describe('onMount', () => {
        it('should register the atom with the registry', () => {
            // Update subscription call
            const subAtom = subscription(mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);

            expect(vi.mocked(registerAtom)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(registerAtom)).toHaveBeenCalledWith(defaultAtomKey, subAtom);
        });

        it('should subscribe to coordinator events (onStateChange, onApplyDelta, onRollback)', () => {
            // Update subscription call
            const subAtom = subscription(mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);

            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onStateChange', expect.any(Function));
            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onApplyDelta', expect.any(Function));
            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onRollback', expect.any(Function));
        });

        it('should call client.subscribe and set status to connecting/connected if enabled', () => {
            // Update subscription call
            const subAtom = subscription(mockProcedureSelector, defaultOptions);
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
            // Update subscription call
            const subAtom = subscription(mockProcedureSelector, { ...defaultOptions, enabled: false });
            simulateMount(subAtom);

            expect(mockSubscribeProcedure).not.toHaveBeenCalled();
            expect(subAtom.get().status).toBe('idle');
        });

        it('should handle error during client.subscribe call', () => {
            const subscribeError = new Error('Connection Refused');
            mockSubscribeProcedure.mockImplementation(() => { throw subscribeError; });

            // Update subscription call
            const subAtom = subscription(mockProcedureSelector, defaultOptions);
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

            // Update subscription call
            const subAtom = subscription(mockProcedureSelector, defaultOptions);
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
        let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function };

        beforeEach(async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            // Update subscription call
            subAtom = subscription(mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);

            expect(mockSubscribeProcedure).toHaveBeenCalledTimes(1);
            expect(subscribeCallbacks).toBeDefined();
            expect(subAtom.get().status).toBe('connected');
            vi.mocked(applyJsonDelta).mockClear();
            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply full snapshot data via onData', () => {
            const snapshotData = { id: '456', content: 'Full Snapshot', version: 1 };

            subscribeCallbacks.onData(snapshotData);

            expect(vi.mocked(applyJsonDelta)).not.toHaveBeenCalled();
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(snapshotData, []);

            expect(subAtom.get().data).toEqual({ ...snapshotData, __appliedOptimistic: true });
            expect(subAtom.get().status).toBe('connected');
            expect(subAtom.get().error).toBeNull();
        });

        it('should apply delta patches via onData', () => {
            const initialSnapshot = { id: '456', content: 'Initial', version: 1 };
            const deltaPatches: PatchOperation[] = [{ op: 'replace', path: '/content', value: 'Delta Update' }, { op: 'add', path: '/newField', value: true }];
            const expectedDataAfterDelta = { ...initialSnapshot, content: 'Delta Update', newField: true, __appliedDelta: true };
            const expectedOptimisticData = { ...expectedDataAfterDelta, __appliedOptimistic: true };

            subscribeCallbacks.onData(initialSnapshot);
            vi.mocked(applyJsonDelta).mockClear();
            vi.mocked(applyImmerPatches).mockClear();

            subscribeCallbacks.onData(deltaPatches);

            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledWith(initialSnapshot, deltaPatches);

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(expectedDataAfterDelta, []);

            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected');
            expect(subAtom.get().error).toBeNull();
        });

         it('should update status from connecting to connected on first data', async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });
            // Update subscription call
            subAtom = subscription(mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);
            expect(subAtom.get().status).toBe('connecting'); // Should be connecting initially

            const snapshotData = { id: '456', content: 'First Data', version: 1 };
            subscribeCallbacks.onData(snapshotData);

            expect(subAtom.get().status).toBe('connected');
        });

    });

    describe('Client Callback Handling (onError, onComplete)', () => {
        let subAtom: SubscriptionAtom<any, any>;
        let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function };

        beforeEach(async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            // Update subscription call
            subAtom = subscription(mockProcedureSelector, defaultOptions);
            simulateMount(subAtom);
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
        let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function };
        const initialData = { id: '456', content: 'Initial', version: 1 };
        const optimisticPatch: Patch[] = [{ op: 'replace', path: ['content'], value: 'Optimistic Content' }];
        const expectedOptimisticData = { ...initialData, content: 'Optimistic Content', __appliedOptimistic: true };

        beforeEach(async () => {
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            // Update subscription call
            subAtom = subscription(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(subAtom);
            expect(subAtom.get().status).toBe('connected');

            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply pending patches from coordinator on onStateChange', () => {
            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(initialData, optimisticPatch);

            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected');
        });

        it('should do nothing if no pending patches for this atom', () => {
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => new Map() as any);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled();
            // Data remains initial data (mock applyImmerPatches adds flag even on empty patches, adjust expectation)
            expect(subAtom.get().data).toEqual({ ...initialData, __appliedOptimistic: true }); // Mock applies flag
        });

        it('should handle errors during optimistic patch application', () => {
            const patchError = new Error('Optimistic Patch failed');
            vi.mocked(applyImmerPatches).mockImplementation(() => { throw patchError; });

            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(subAtom.get().status).toBe('error');
            expect(subAtom.get().error).toBe(patchError);
            expect(subAtom.get().data).toEqual(initialData);
        });
    });

    describe('Coordinator Event Handling (onApplyDelta, onRollback)', () => {
        let subAtom: SubscriptionAtom<any, any>;
        const initialData = { id: '456', content: 'Initial', version: 1 };

        beforeEach(async () => {
            mockSubscribeProcedure.mockImplementation(() => ({ unsubscribe: mockClientUnsubscribe }));

            // Update subscription call
            subAtom = subscription(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(subAtom);
            expect(subAtom.get().status).toBe('connected');

            vi.mocked(applyJsonDelta).mockClear();
            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply delta patches from coordinator via onApplyDelta', () => {
            const coordDeltaPatch: PatchOperation[] = [{ op: 'replace', path: '/content', value: 'Coordinator Delta' }];
            const expectedDataAfterDelta = { ...initialData, content: 'Coordinator Delta', __appliedDelta: true };
            const expectedOptimisticData = { ...expectedDataAfterDelta, __appliedOptimistic: true };

            const serverDelta: ServerDelta = { serverSeq: 2, key: defaultAtomKey, patches: coordDeltaPatch };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledWith(initialData, coordDeltaPatch);

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(expectedDataAfterDelta, []);

            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected');
        });

        it('should ignore coordinator deltas for different atom keys', () => {
            const serverDelta: ServerDelta = { serverSeq: 2, key: 'other/key', patches: [{ op: 'add', path: '/foo', value: 1 }] };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(applyJsonDelta)).not.toHaveBeenCalled();
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
            vi.mocked(applyImmerPatches).mockReturnValueOnce(rolledBackState); // Mock the result of computeOptimisticState after rollback

            (mockCoordinatorInstance as any).__mockEmit('onRollback', rollbackMap);

            // Check applyImmerPatches called by rollback handler AND subsequent computeOptimisticState
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(2); // Once for rollback, once for recompute
            // Check the call that applied the inverse patch
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(optimisticStateBeforeRollback, inversePatch);
            // Check the call from computeOptimisticState after rollback
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(rolledBackState, []); // Assuming no other pending patches

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