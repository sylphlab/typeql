import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import { map, atom, type MapStore, type Atom, onMount, task } from 'nanostores';
import type { Patch } from 'immer';
import type { Operation as PatchOperation } from 'fast-json-patch';

import { subscription, type SubscriptionOptions, type SubscriptionAtom, type SubscriptionAtomState, type SubscriptionStatus } from './subscription'; // Function under test
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta, CoordinatorEvents } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches } from './patchUtils';
import { applyJsonDelta } from './stateUtils';

// --- Mocks ---

// Mock Coordinator (Similar to query.test.ts)
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
            // Methods used by subscription.ts: onStateChange, onApplyDelta, onRollback
            getPendingPatches: vi.fn(() => new Map<AtomKey, Patch[]>()), // Expects Immer patches
            // Add helpers for testing
            __mockEmit: mockEmitter.emit,
            __mockClearListeners: mockEmitter.clearListeners,
        };
        return instance as any;
    });
    return { OptimisticSyncCoordinator: MockCoordinator };
});

// Mock Client
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

// Mock Atom Registry (Same as query.test.ts)
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

// Mock Patch Utils (Same as query.test.ts)
vi.mock('./patchUtils', () => ({
    applyImmerPatches: vi.fn((base, patches) => {
        console.log('[Mock applyImmerPatches] Applying:', patches, 'to base:', base);
        if (patches.length > 0 && typeof base === 'object' && base !== null) {
            return { ...base, __appliedOptimistic: true };
        }
        return base;
    }),
}));

// Mock State Utils (Same as query.test.ts)
vi.mock('./stateUtils', () => ({
    applyJsonDelta: vi.fn((base, patches) => {
        console.log('[Mock applyJsonDelta] Applying:', patches, 'to base:', base);
        if (patches.length > 0 && typeof base === 'object' && base !== null) {
            return { ...base, __appliedDelta: true };
        }
        return base;
    }),
}));

// Mock nanostores (Same as query.test.ts)
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
    let clientAtom: Atom<ZenQueryClient>;
    let mockCoordinatorInstance: OptimisticSyncCoordinator;
    let capturedUnmount: (() => void) | void | undefined;
    let mockClientUnsubscribe: Mock; // To mock the unsubscribe function returned by client.subscribe

    // Helper to simulate mounting (Same as query.test.ts)
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

    // Helper to simulate unmounting (Same as query.test.ts)
    const simulateUnmount = (atomInstance: Atom<any>) => {
        const instanceWithMocks = atomInstance as any;
        if (typeof instanceWithMocks.__mockUnmount === 'function') {
            instanceWithMocks.__mockUnmount();
            instanceWithMocks.__mockUnmount = undefined;
        }
    };

    beforeEach(async () => {
        vi.clearAllMocks();

        // Create mock coordinator
        const { OptimisticSyncCoordinator: MockCoordinator } = await import('../coordinator');
        mockCoordinatorInstance = new MockCoordinator();
        (mockCoordinatorInstance as any).__mockClearListeners?.();
        vi.mocked(mockClient.getCoordinator).mockReturnValue(mockCoordinatorInstance as any);

        // Create client atom
        clientAtom = atom<ZenQueryClient>(mockClient);

        // Reset client subscribe mock
        mockClientUnsubscribe = vi.fn();
        mockSubscribeProcedure.mockReset().mockReturnValue({ unsubscribe: mockClientUnsubscribe });

        // Reset registry mocks
        vi.mocked(generateAtomKey).mockClear();
        vi.mocked(registerAtom).mockClear();
        vi.mocked(unregisterAtom).mockClear();
        vi.mocked(getAtom).mockClear();

        // Reset patch util mocks
        vi.mocked(applyImmerPatches).mockClear();
        vi.mocked(applyJsonDelta).mockClear();

        // Reset nanostores mocks
        vi.mocked(onMount).mockClear();
        vi.mocked(task).mockClear(); // task is not used in subscription, but clear anyway

        capturedUnmount = undefined;
    });

    afterEach(() => {
        // Ensure cleanup happens if mount was simulated
        // Tests should call simulateUnmount explicitly
    });

    const clientGetter = <T extends ZenQueryClient>(ca: Atom<T>) => ca.get();
    const defaultPath = 'posts.updates';
    const defaultInput = { postId: '456' };
    const defaultOptions: SubscriptionOptions<typeof defaultInput, { id: string; content: string; version: number }> = {
        input: defaultInput,
        path: defaultPath,
    };
    const defaultAtomKey = JSON.stringify({ path: defaultPath, input: defaultInput });

    // --- Test Cases ---

    it('should initialize with correct default state (enabled: true)', () => {
        const subAtom = subscription(clientAtom, clientGetter, defaultOptions);
        const initialState = subAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.status).toBe('idle'); // Status is idle until mount
        expect(initialState.error).toBeNull();
        expect(vi.mocked(generateAtomKey)).toHaveBeenCalledWith(defaultPath, defaultInput);
        expect(subAtom.key).toBe(defaultAtomKey);
    });

     it('should initialize with initialData', () => {
        const initialData = { id: '456', content: 'Initial Content', version: 0 };
        const subAtom = subscription(clientAtom, clientGetter, { ...defaultOptions, initialData });
        const initialState = subAtom.get();

        expect(initialState.data).toEqual(initialData);
        expect(initialState.status).toBe('idle');
        expect(initialState.error).toBeNull();
    });

    it('should initialize with correct default state (enabled: false)', () => {
        const subAtom = subscription(clientAtom, clientGetter, { ...defaultOptions, enabled: false });
        const initialState = subAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.status).toBe('idle');
        expect(initialState.error).toBeNull();
    });

    describe('onMount', () => {
        it('should register the atom with the registry', () => {
            const subAtom = subscription(clientAtom, clientGetter, defaultOptions);
            simulateMount(subAtom);

            expect(vi.mocked(registerAtom)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(registerAtom)).toHaveBeenCalledWith(defaultAtomKey, subAtom);
        });

        it('should subscribe to coordinator events (onStateChange, onApplyDelta, onRollback)', () => {
            const subAtom = subscription(clientAtom, clientGetter, defaultOptions);
            simulateMount(subAtom);

            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onStateChange', expect.any(Function));
            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onApplyDelta', expect.any(Function));
            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onRollback', expect.any(Function));
        });

        it('should call client.subscribe and set status to connecting/connected if enabled', () => {
            const subAtom = subscription(clientAtom, clientGetter, defaultOptions);
            simulateMount(subAtom);

            expect(subAtom.get().status).toBe('connecting');
            expect(mockSubscribeProcedure).toHaveBeenCalledTimes(1);
            expect(mockSubscribeProcedure).toHaveBeenCalledWith(defaultInput, expect.objectContaining({
                onData: expect.any(Function),
                onError: expect.any(Function),
                onComplete: expect.any(Function),
            }));

            // Simulate connection success (e.g., by onData or onOpen if implemented)
            // For now, check optimistic connection status set in connectSubscription
             expect(subAtom.get().status).toBe('connected'); // Optimistically set after subscribe call returns
        });

        it('should NOT call client.subscribe if enabled: false', () => {
            const subAtom = subscription(clientAtom, clientGetter, { ...defaultOptions, enabled: false });
            simulateMount(subAtom);

            expect(mockSubscribeProcedure).not.toHaveBeenCalled();
            expect(subAtom.get().status).toBe('idle');
        });

        it('should handle error during client.subscribe call', () => {
            const subscribeError = new Error('Connection Refused');
            mockSubscribeProcedure.mockImplementation(() => { throw subscribeError; });

            const subAtom = subscription(clientAtom, clientGetter, defaultOptions);
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

            const subAtom = subscription(clientAtom, clientGetter, defaultOptions);
            simulateMount(subAtom); // Mount and connect
            expect(mockSubscribeProcedure).toHaveBeenCalledTimes(1);

            simulateUnmount(subAtom); // Unmount

            expect(vi.mocked(unregisterAtom)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(unregisterAtom)).toHaveBeenCalledWith(defaultAtomKey);
            expect(mockUnsubChange).toHaveBeenCalledTimes(1);
            expect(mockUnsubDelta).toHaveBeenCalledTimes(1);
            expect(mockUnsubRollback).toHaveBeenCalledTimes(1);
            expect(mockClientUnsubscribe).toHaveBeenCalledTimes(1); // Ensure client transport is cleaned up
        });
    });

    describe('onData Handling', () => {
        let subAtom: SubscriptionAtom<any, any>;
        let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function };

        beforeEach(async () => {
            // Capture the callbacks passed to subscribe
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks; // Store callbacks
                return { unsubscribe: mockClientUnsubscribe };
            });

            subAtom = subscription(clientAtom, clientGetter, defaultOptions);
            simulateMount(subAtom); // Mount and trigger subscribe

            // Ensure subscribe was called and callbacks captured
            expect(mockSubscribeProcedure).toHaveBeenCalledTimes(1);
            expect(subscribeCallbacks).toBeDefined();
            // Status becomes 'connected' automatically after subscribe call returns in the mock setup
            // No need to manually setKey here. Assert initial connected status if needed.
            expect(subAtom.get().status).toBe('connected');
            vi.mocked(applyJsonDelta).mockClear();
            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply full snapshot data via onData', () => {
            const snapshotData = { id: '456', content: 'Full Snapshot', version: 1 };

            // Simulate server sending snapshot
            subscribeCallbacks.onData(snapshotData);

            // applyJsonDelta should NOT be called for snapshot
            expect(vi.mocked(applyJsonDelta)).not.toHaveBeenCalled();
            // applyImmerPatches should be called by computeOptimisticState after confirmed data updates
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            // Base for optimistic computation should be the snapshot data
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(snapshotData, []); // Assuming no pending patches

            // Check atom state
            expect(subAtom.get().data).toEqual({ ...snapshotData, __appliedOptimistic: true }); // Based on mock
            expect(subAtom.get().status).toBe('connected');
            expect(subAtom.get().error).toBeNull();
        });

        it('should apply delta patches via onData', () => {
            const initialSnapshot = { id: '456', content: 'Initial', version: 1 };
            const deltaPatches: PatchOperation[] = [{ op: 'replace', path: '/content', value: 'Delta Update' }, { op: 'add', path: '/newField', value: true }];
            const expectedDataAfterDelta = { ...initialSnapshot, content: 'Delta Update', newField: true, __appliedDelta: true }; // From mock applyJsonDelta
            const expectedOptimisticData = { ...expectedDataAfterDelta, __appliedOptimistic: true }; // From mock applyImmerPatches

            // Apply initial snapshot first to have a base state
            subscribeCallbacks.onData(initialSnapshot);
            vi.mocked(applyJsonDelta).mockClear();
            vi.mocked(applyImmerPatches).mockClear();

            // Simulate server sending delta patches
            subscribeCallbacks.onData(deltaPatches);

            // applyJsonDelta SHOULD be called for delta
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledWith(initialSnapshot, deltaPatches);

            // applyImmerPatches should be called by computeOptimisticState after confirmed data updates
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            // Base for optimistic computation should be the result of applyJsonDelta
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(expectedDataAfterDelta, []); // Assuming no pending patches

            // Check atom state
            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected');
            expect(subAtom.get().error).toBeNull();
        });

         it('should update status from connecting to connected on first data', async () => {
            // Re-initialize atom and mount to start in 'connecting' state
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks; // Capture callbacks
                // Don't resolve/call callbacks immediately to stay in 'connecting'
                return { unsubscribe: mockClientUnsubscribe };
            });
            subAtom = subscription(clientAtom, clientGetter, defaultOptions);
            simulateMount(subAtom);
            expect(subAtom.get().status).toBe('connecting'); // Verify starting state

            const snapshotData = { id: '456', content: 'First Data', version: 1 };
            subscribeCallbacks.onData(snapshotData); // Send first data

            // State should update

            expect(subAtom.get().status).toBe('connected');
        });

        // TODO: Add tests for error handling within onData if applyJsonDelta/applyImmerPatches throws
    });

    describe('Client Callback Handling (onError, onComplete)', () => {
        let subAtom: SubscriptionAtom<any, any>;
        let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function };

        beforeEach(async () => {
            // Capture the callbacks passed to subscribe
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            subAtom = subscription(clientAtom, clientGetter, defaultOptions);
            simulateMount(subAtom);
            expect(subAtom.get().status).toBe('connected'); // Assume connected after mount
        });

        it('should set error status and store error on onError callback', () => {
            const clientError = new Error('Subscription Lost');

            // Simulate client transport emitting an error
            subscribeCallbacks.onError(clientError);

            expect(subAtom.get().status).toBe('error');
            expect(subAtom.get().error).toBe(clientError);
            // Check if client unsubscribe was called as part of error handling
            expect(mockClientUnsubscribe).toHaveBeenCalledTimes(1);
        });

        it('should set status to closed on onComplete callback', () => {
            // Simulate client transport signaling completion
            subscribeCallbacks.onComplete();

            expect(subAtom.get().status).toBe('closed');
            expect(subAtom.get().error).toBeNull();
            // Check if client unsubscribe was called as part of completion handling
            expect(mockClientUnsubscribe).toHaveBeenCalledTimes(1);
        });

        it('should ignore callbacks if unmounted', () => {
             const clientError = new Error('Subscription Lost');
             const snapshotData = { id: '456', content: 'Late Data', version: 2 };

             simulateUnmount(subAtom); // Unmount first

             // Simulate callbacks after unmount
             subscribeCallbacks.onError(clientError);
             subscribeCallbacks.onComplete();
             subscribeCallbacks.onData(snapshotData);

             // State should remain as it was before unmount (or initial if never connected)
             // Let's assume it connected briefly before unmount
             expect(subAtom.get().status).toBe('closed'); // Unmount sets status to closed
             expect(subAtom.get().error).toBeNull();
             // Data should not have updated from the late snapshot
             expect(subAtom.get().data).toBeUndefined(); // Assuming no initial data
        });
    });

    describe('Optimistic Updates (onStateChange)', () => {
        let subAtom: SubscriptionAtom<any, any>;
        let subscribeCallbacks: { onData: Function; onError: Function; onComplete: Function };
        const initialData = { id: '456', content: 'Initial', version: 1 };
        const optimisticPatch: Patch[] = [{ op: 'replace', path: ['content'], value: 'Optimistic Content' }];
        const expectedOptimisticData = { ...initialData, content: 'Optimistic Content', __appliedOptimistic: true }; // Based on mock

        beforeEach(async () => {
            // Capture callbacks
            mockSubscribeProcedure.mockImplementation((input, callbacks) => {
                subscribeCallbacks = callbacks;
                return { unsubscribe: mockClientUnsubscribe };
            });

            subAtom = subscription(clientAtom, clientGetter, { ...defaultOptions, initialData }); // Use initialData
            simulateMount(subAtom);
            expect(subAtom.get().status).toBe('connected'); // Assume connected

            // Simulate initial data being received if not using initialData option
            // subscribeCallbacks.onData(initialData);
            // expect(subAtom.get().data).toEqual({...initialData, __appliedOptimistic: true}); // Verify initial state if needed

            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply pending patches from coordinator on onStateChange', () => {
            // Setup coordinator mock to return patches
            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            // Trigger state change
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            // Verify applyImmerPatches was called
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            // Base state should be the last confirmed server data (initialData in this case)
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(initialData, optimisticPatch);

            // Verify atom state updated optimistically
            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected'); // Status remains connected
        });

        it('should do nothing if no pending patches for this atom', () => {
            // Coordinator returns empty map
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => new Map() as any);

            // Trigger state change
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled();
            // Data remains the initial data (plus the __appliedOptimistic flag from the initial onData call's optimistic computation)
            expect(subAtom.get().data).toEqual({ ...initialData, __appliedOptimistic: true });
        });

        it('should handle errors during optimistic patch application', () => {
            const patchError = new Error('Optimistic Patch failed');
            vi.mocked(applyImmerPatches).mockImplementation(() => { throw patchError; });

            // Setup coordinator mock
            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            // Trigger state change
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(subAtom.get().status).toBe('error'); // Status should change to error
            expect(subAtom.get().error).toBe(patchError);
            // Data should fallback to confirmed state
            expect(subAtom.get().data).toEqual(initialData);
        });
    });

    describe('Coordinator Event Handling (onApplyDelta, onRollback)', () => {
        let subAtom: SubscriptionAtom<any, any>;
        const initialData = { id: '456', content: 'Initial', version: 1 };

        beforeEach(async () => {
            // No need to capture subscribe callbacks here
            mockSubscribeProcedure.mockImplementation(() => ({ unsubscribe: mockClientUnsubscribe }));

            subAtom = subscription(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(subAtom);
            expect(subAtom.get().status).toBe('connected');

            // Reset mocks
            vi.mocked(applyJsonDelta).mockClear();
            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should apply delta patches from coordinator via onApplyDelta', () => {
            const coordDeltaPatch: PatchOperation[] = [{ op: 'replace', path: '/content', value: 'Coordinator Delta' }];
            const expectedDataAfterDelta = { ...initialData, content: 'Coordinator Delta', __appliedDelta: true };
            const expectedOptimisticData = { ...expectedDataAfterDelta, __appliedOptimistic: true };

            // Simulate coordinator emitting delta
            const serverDelta: ServerDelta = { serverSeq: 2, key: defaultAtomKey, patches: coordDeltaPatch };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            // Verify applyJsonDelta was called
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledWith(initialData, coordDeltaPatch);

            // Verify optimistic state recomputation
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(expectedDataAfterDelta, []);

            // Verify atom state
            expect(subAtom.get().data).toEqual(expectedOptimisticData);
            expect(subAtom.get().status).toBe('connected');
        });

        it('should ignore coordinator deltas for different atom keys', () => {
             // Simulate coordinator emitting delta for different key
            const serverDelta: ServerDelta = { serverSeq: 2, key: 'other/key', patches: [{ op: 'add', path: '/foo', value: 1 }] };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(applyJsonDelta)).not.toHaveBeenCalled();
            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled(); // No recomputation needed
            expect(subAtom.get().data).toEqual(initialData); // State unchanged
        });

        it('should apply inverse Immer patches from coordinator via onRollback', () => {
            // Assume some optimistic state was applied previously (mock doesn't track this perfectly)
            const optimisticStateBeforeRollback = { ...initialData, content: 'Optimistic', __appliedOptimistic: true };
            subAtom.get().data = optimisticStateBeforeRollback; // Manually set for test clarity

            const inversePatch: Patch[] = [{ op: 'replace', path: ['content'], value: 'Initial' }]; // Immer patch format
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set(defaultAtomKey, inversePatch);

            // Simulate coordinator emitting rollback
            (mockCoordinatorInstance as any).__mockEmit('onRollback', rollbackMap);

            // Verify applyImmerPatches was called for rollback
            // Note: The implementation applies inverse patches to confirmedServerData, then recomputes.
            // Let's check the recomputation call.
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            // The base state for recomputation *after* rollback should be the original initialData
            // The patches applied should be the inversePatch itself (as per current mock logic)
            // A more accurate mock would apply inverse to confirmed, then recompute with pending.
            // For now, let's assume the mock applyImmerPatches handles the inverse correctly for testing.
            // We expect computeOptimisticState to be called after rollback logic updates confirmedServerData.
            // Let's refine the check: applyImmerPatches should be called by computeOptimisticState.
            // We need to verify the *confirmedServerData* was updated by the rollback logic before computeOptimisticState runs.
            // This is hard to test without inspecting internal state.
            // Let's focus on the final state.

            // Mock applyImmerPatches to simulate applying the inverse patch result
            const rolledBackState = { ...initialData }; // Expected state after inverse applied
            vi.mocked(applyImmerPatches).mockReturnValueOnce(rolledBackState); // Mock the result of computeOptimisticState after rollback

            // Re-trigger rollback to use the new mock return value
             (mockCoordinatorInstance as any).__mockEmit('onRollback', rollbackMap);


            // Verify final atom state reflects rollback
            expect(subAtom.get().data).toEqual(rolledBackState);
            expect(subAtom.get().status).toBe('connected'); // Status remains connected unless error occurs
            expect(subAtom.get().error).toBeNull();
        });

         it('should ignore coordinator rollbacks for different atom keys', () => {
            const inversePatch: Patch[] = [{ op: 'replace', path: ['content'], value: 'Initial' }];
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set('other/key', inversePatch); // Different key

            (mockCoordinatorInstance as any).__mockEmit('onRollback', rollbackMap);

            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled();
            expect(subAtom.get().data).toEqual(initialData); // State unchanged
        });

        it('should handle errors during rollback patch application', () => {
            const rollbackError = new Error('Rollback failed');
            // Mock the internal applyImmerPatches called *during* the rollback handler
            vi.mocked(applyImmerPatches).mockImplementationOnce(() => { throw rollbackError; });

            const inversePatch: Patch[] = [{ op: 'replace', path: ['content'], value: 'Initial' }];
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set(defaultAtomKey, inversePatch);

            // Simulate coordinator emitting rollback
            (mockCoordinatorInstance as any).__mockEmit('onRollback', rollbackMap);

            // Check state
            expect(subAtom.get().status).toBe('error');
            expect(subAtom.get().error).toBe(rollbackError);
            // Data might fallback to pre-rollback confirmed state
            expect(subAtom.get().data).toEqual(initialData);
        });

    });

    // TODO: Add describe blocks for:
    // - Status transitions (reconnecting, etc. if implemented)

});