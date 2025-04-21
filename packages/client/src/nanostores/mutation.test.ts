import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import { map, atom, type MapStore, type Atom, onMount, task } from 'nanostores';
import type { Patch, Draft } from 'immer';
import type { Operation as PatchOperation } from 'fast-json-patch';

import { mutation, effect, type MutationOptions, type MutationAtom, type MutationAtomState, type MutationEffect } from './mutation'; // Function under test
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta, CoordinatorEvents } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches, produceImmerPatches } from './patchUtils'; // Need produceImmerPatches

// --- Mocks ---

// Mock Coordinator (Similar to previous tests, adding methods used by mutation)
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
            // Methods used by mutation.ts: generateClientSeq, registerPendingMutation, onAck, onError, onRollback
            generateClientSeq: vi.fn(() => Date.now()), // Simple mock implementation
            registerPendingMutation: vi.fn(),
            getPendingPatches: vi.fn(() => new Map<AtomKey, Patch[]>()), // Use Immer Patch
            // Add helpers for testing
            __mockEmit: mockEmitter.emit,
            __mockClearListeners: mockEmitter.clearListeners,
        };
        return instance as any;
    });
    return { OptimisticSyncCoordinator: MockCoordinator };
});

// Mock Client
const mockMutateProcedure = vi.fn();
const mockClient = {
    mutation: { // Mock mutation procedures
        posts: {
            create: {
                mutate: mockMutateProcedure,
            },
            update: {
                 mutate: mockMutateProcedure, // Can use the same mock for different paths
            }
        },
    },
    getCoordinator: vi.fn(),
} as unknown as ZenQueryClient;

// Mock Atom Registry (Same as previous tests)
// Keep track of registered atoms for effect tests
const mockAtomStore: Record<AtomKey, MapStore<any>> = {};
vi.mock('../utils/atomRegistry', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        generateAtomKey: vi.fn((path, input) => JSON.stringify({ path, input })),
        registerAtom: vi.fn((key, atomInstance) => { mockAtomStore[key] = atomInstance; }),
        unregisterAtom: vi.fn((key) => { delete mockAtomStore[key]; }),
        getAtom: vi.fn((key) => mockAtomStore[key]), // Return stored mock atom
    };
});

// Mock Patch Utils (Need produceImmerPatches mock)
vi.mock('./patchUtils', () => ({
    applyImmerPatches: vi.fn((base, patches) => {
        console.log('[Mock applyImmerPatches] Applying:', patches, 'to base:', base);
        // Simulate applying patches for verification
        let newState = structuredClone(base); // Simple clone
        if (patches.length > 0 && typeof newState === 'object' && newState !== null) {
             patches.forEach((patch: Patch) => {
                if (patch.op === 'replace' && patch.path.length === 1 && patch.path[0] === 'content') {
                    newState.content = patch.value; // Specific mock for test case
                } else if (patch.op === 'add' && patch.path.length === 1 && patch.path[0] === 'title') {
                     newState.title = patch.value; // Specific mock for test case
                }
             });
            newState.__appliedOptimistic = true;
        }
        return newState;
    }),
    // Mock produceImmerPatches to return predictable patches/inverses
    produceImmerPatches: vi.fn((base, recipe) => {
        console.log('[Mock produceImmerPatches] Producing for base:', base);
        // Simulate recipe execution and generate mock patches/inverses
        const mockPatches: Patch[] = [{ op: 'replace', path: ['title'], value: 'Optimistic Mock Title' }];
        const mockInversePatches: Patch[] = [{ op: 'replace', path: ['title'], value: base?.title ?? 'Original Mock Title' }];
        // Simulate the next state based on mock patches
        const nextState = { ...(base ?? {}), title: 'Optimistic Mock Title', __appliedOptimistic: true };
        return [nextState, mockPatches, mockInversePatches];
    }),
}));

// Mock nanostores (onMount needed for rollback listener registration)
vi.mock('nanostores', async (importOriginal) => {
    const actual = await importOriginal() as typeof import('nanostores');
    return {
        ...actual,
        task: vi.fn((fn) => fn), // task() used by mutation
        onMount: vi.fn((store: import('nanostores').Store, initialize?: () => void | (() => void)) => {
            const storeWithMocks = store as any;
            if (!storeWithMocks.__mockMountCallbacks) storeWithMocks.__mockMountCallbacks = [];
            storeWithMocks.__mockMountCallbacks.push(initialize);
            return () => {};
        }),
    };
});

// --- Test Suite ---

describe('Nanostores mutation() helper', () => {
    let clientAtom: Atom<ZenQueryClient>;
    let mockCoordinatorInstance: OptimisticSyncCoordinator & { __mockEmit: Function }; // Add emit type
    // Adjust targetAtom type to match QuerySubscriptionMapState more closely (data is not optional in the base type)
    type TargetAtomState = { data: { id: string; title: string } | undefined, status: string, error: any };
    let targetAtom: MapStore<TargetAtomState> & { key: AtomKey };
    const targetAtomKey = 'target/atom';

    // Helpers (can be shared)
    const simulateMount = (atomInstance: Atom<any>) => { /* ... */ };
    const simulateUnmount = (atomInstance: Atom<any>) => { /* ... */ };

    beforeEach(async () => {
        vi.clearAllMocks();
        // Clear atom store
        Object.keys(mockAtomStore).forEach(key => delete mockAtomStore[key]);

        // Create mock coordinator
        const { OptimisticSyncCoordinator: MockCoordinator } = await import('../coordinator');
        mockCoordinatorInstance = new MockCoordinator() as OptimisticSyncCoordinator & { __mockEmit: Function };
        (mockCoordinatorInstance as any).__mockClearListeners?.();
        vi.mocked(mockClient.getCoordinator).mockReturnValue(mockCoordinatorInstance as any);

        // Create client atom
        clientAtom = atom<ZenQueryClient>(mockClient);

        // Reset client mutate mock
        mockMutateProcedure.mockReset();

        // Reset registry mocks
        vi.mocked(generateAtomKey).mockClear();
        vi.mocked(registerAtom).mockClear();
        vi.mocked(unregisterAtom).mockClear();
        vi.mocked(getAtom).mockClear().mockImplementation((key) => mockAtomStore[key]); // Ensure getAtom uses store

        // Reset patch util mocks
        vi.mocked(applyImmerPatches).mockClear();
        vi.mocked(produceImmerPatches).mockClear();

        // Reset nanostores mocks
        vi.mocked(onMount).mockClear();
        vi.mocked(task).mockClear();

        // Create a mock target atom for effects
        const mapStore = map<TargetAtomState>({ data: { id: '1', title: 'Initial Target' }, status: 'success', error: null });
        // Assign the key property and then cast to the final type
        targetAtom = Object.assign(mapStore, { key: targetAtomKey }) as MapStore<TargetAtomState> & { key: AtomKey };
        mockAtomStore[targetAtomKey] = targetAtom; // Register mock atom

    });

    const clientGetter = <T extends ZenQueryClient>(ca: Atom<T>) => ca.get();
    const defaultPath = 'posts.create';
    const defaultInput = { title: 'New Post', content: 'Hello' };
    const defaultOptions: MutationOptions<any, any, typeof defaultInput> = {};

    // --- Test Cases ---

    it('should initialize with correct default state', () => {
        const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [], defaultOptions);
        const initialState = mutationAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.loading).toBe(false);
        expect(initialState.error).toBeNull();
        expect(initialState.variables).toBeUndefined();
        expect(initialState.status).toBe('idle');
    });

    describe('mutate() function', () => {
        const mutationVariables = { title: 'Test Title', content: 'Test Content' };
        const mockClientSeq = 12345;
        const mockServerResult = { id: 'new-post-id', title: 'Test Title' };
        const mockPatches: Patch[] = [{ op: 'replace', path: ['title'], value: 'Optimistic Mock Title' }];
        const mockInversePatches: Patch[] = [{ op: 'replace', path: ['title'], value: 'Initial Target' }];

        beforeEach(() => {
            vi.mocked(mockCoordinatorInstance.generateClientSeq).mockReturnValue(mockClientSeq);
            // Reset produceImmerPatches mock for specific return values if needed
             vi.mocked(produceImmerPatches).mockReturnValue([
                { id: '1', title: 'Optimistic Mock Title', __appliedOptimistic: true }, // nextState
                mockPatches,
                mockInversePatches
            ]);
        });

        it('should set loading state and variables immediately', async () => {
            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [], defaultOptions);
            const mutatePromise = mutationAtom.mutate(mutationVariables); // Don't await yet

            const state = mutationAtom.get();
            expect(state.loading).toBe(true);
            expect(state.status).toBe('loading');
            expect(state.variables).toEqual(mutationVariables);
            expect(state.error).toBeNull();
            expect(state.data).toBeUndefined();

            // Clean up promise to avoid unhandled rejection warnings
            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });

        it('should call produceImmerPatches for each effect', async () => {
            const effect1Recipe = vi.fn();
            const effect2Recipe = vi.fn();
            const effect1 = effect(targetAtom, effect1Recipe);
            const effect2 = effect(targetAtom, effect2Recipe); // Can target same atom

            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [effect1, effect2], defaultOptions);
            const mutatePromise = mutationAtom.mutate(mutationVariables);

            // produceImmerPatches should be called twice
            expect(vi.mocked(produceImmerPatches)).toHaveBeenCalledTimes(2);
            // Check it was called with the correct base state and recipe
            expect(vi.mocked(produceImmerPatches)).toHaveBeenCalledWith(targetAtom.get().data, expect.any(Function));

            // Clean up
            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });

         it('should update target atom data based on produceImmerPatches result', async () => {
            const effectRecipe = vi.fn();
            const testEffect = effect(targetAtom, effectRecipe);
            const expectedNextState = { id: '1', title: 'Optimistic Mock Title', __appliedOptimistic: true }; // From produceImmerPatches mock

            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [testEffect], defaultOptions);
            const mutatePromise = mutationAtom.mutate(mutationVariables);

            expect(vi.mocked(produceImmerPatches)).toHaveBeenCalledTimes(1);
            // Check that the target atom's data was updated
            expect(targetAtom.get().data).toEqual(expectedNextState);

            // Clean up
            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });


        it('should call coordinator.registerPendingMutation with generated patches', async () => {
            const effectRecipe = vi.fn();
            const testEffect = effect(targetAtom, effectRecipe);

            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [testEffect], defaultOptions);
            const mutatePromise = mutationAtom.mutate(mutationVariables);

            expect(vi.mocked(mockCoordinatorInstance.registerPendingMutation)).toHaveBeenCalledTimes(1);
            const expectedPatchesMap = new Map<AtomKey, Patch[]>();
            expectedPatchesMap.set(targetAtomKey, mockPatches);
            const expectedInversePatchesMap = new Map<AtomKey, Patch[]>();
            expectedInversePatchesMap.set(targetAtomKey, mockInversePatches);

            expect(vi.mocked(mockCoordinatorInstance.registerPendingMutation)).toHaveBeenCalledWith(
                mockClientSeq,
                expectedPatchesMap,
                expectedInversePatchesMap
            );

            // Clean up
            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });

        it('should call the correct client mutation procedure', async () => {
            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [], defaultOptions);
            const mutatePromise = mutationAtom.mutate(mutationVariables);

            expect(mockMutateProcedure).toHaveBeenCalledTimes(1);
            expect(mockMutateProcedure).toHaveBeenCalledWith({
                input: mutationVariables,
                clientSeq: mockClientSeq,
            });

            // Clean up
            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });

        it('should resolve promise and set success state on coordinator onAck', async () => {
            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [], defaultOptions);
            const mutatePromise = mutationAtom.mutate(mutationVariables);

            // Simulate coordinator ack
            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);

            // Check promise resolution
            await expect(mutatePromise).resolves.toEqual(mockServerResult);

            // Check final state
            const state = mutationAtom.get();
            expect(state.loading).toBe(false);
            expect(state.status).toBe('success');
            expect(state.data).toEqual(mockServerResult);
            expect(state.error).toBeNull();
            expect(state.variables).toEqual(mutationVariables);
        });

        it('should reject promise and set error state on coordinator onError', async () => {
            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [], defaultOptions);
            const mutatePromise = mutationAtom.mutate(mutationVariables);
            const mutationError = new Error('Server Rejected Mutation');

            // Simulate coordinator error
            mockCoordinatorInstance.__mockEmit('onError', mockClientSeq, mutationError);

            // Check promise rejection
            await expect(mutatePromise).rejects.toThrow('Server Rejected Mutation');

            // Check final state
            const state = mutationAtom.get();
            expect(state.loading).toBe(false);
            expect(state.status).toBe('error');
            expect(state.error).toEqual(mutationError);
            expect(state.data).toBeUndefined();
            expect(state.variables).toEqual(mutationVariables);
        });

        it('should handle errors during optimistic update phase', async () => {
            const optimisticError = new Error('Failed applying optimistic effect');
            vi.mocked(produceImmerPatches).mockImplementation(() => { throw optimisticError; });
            const effectRecipe = vi.fn();
            const testEffect = effect(targetAtom, effectRecipe);

            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [testEffect], defaultOptions);

            // Mutate and expect rejection
            await expect(mutationAtom.mutate(mutationVariables)).rejects.toThrow('Failed applying optimistic effect');

            // Check final state
            const state = mutationAtom.get();
            expect(state.loading).toBe(false);
            expect(state.status).toBe('error');
            expect(state.error).toEqual(optimisticError);
            expect(state.data).toBeUndefined();
            expect(state.variables).toEqual(mutationVariables);

            // Ensure client procedure and coordinator registration were NOT called
            expect(mockMutateProcedure).not.toHaveBeenCalled();
            expect(vi.mocked(mockCoordinatorInstance.registerPendingMutation)).not.toHaveBeenCalled();
        });

         it('should handle errors during client procedure invocation', async () => {
            const invocationError = new Error('Procedure not found');
            mockMutateProcedure.mockImplementation(() => { throw invocationError; });

            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [], defaultOptions);

            // Mutate and expect rejection
            await expect(mutationAtom.mutate(mutationVariables)).rejects.toThrow('Procedure not found');

             // Check final state
            const state = mutationAtom.get();
            expect(state.loading).toBe(false);
            expect(state.status).toBe('error');
            expect(state.error).toEqual(invocationError);
            expect(state.data).toBeUndefined();
            expect(state.variables).toEqual(mutationVariables);

            // Coordinator registration should still happen before invocation attempt
             expect(vi.mocked(mockCoordinatorInstance.registerPendingMutation)).toHaveBeenCalledTimes(1);
             // Ensure ack/error listeners were cleaned up (hard to test directly without exposing internals)
        });

    });

    describe('Coordinator Rollback Handling', () => {
        // Rollback is handled by a listener setup onMount.
        // We need to mount the mutation atom to test this.

        const mutationVariables = { title: 'Test Title' };
        const mockClientSeq = 12345;
        const mockPatches: Patch[] = [{ op: 'replace', path: ['title'], value: 'Optimistic Mock Title' }];
        const mockInversePatches: Patch[] = [{ op: 'replace', path: ['title'], value: 'Initial Target' }];

        beforeEach(() => {
            vi.mocked(mockCoordinatorInstance.generateClientSeq).mockReturnValue(mockClientSeq);
            vi.mocked(produceImmerPatches).mockReturnValue([
                { id: '1', title: 'Optimistic Mock Title', __appliedOptimistic: true },
                mockPatches,
                mockInversePatches
            ]);
            // Mount the mutation atom to register the rollback listener
            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [], defaultOptions);
            // simulateMount(mutationAtom); // Mount is implicitly handled by nanostores mock now
            vi.mocked(applyImmerPatches).mockClear(); // Clear any calls during setup
        });

        it('should call applyImmerPatches with inverse patches on onRollback', () => {
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set(targetAtomKey, mockInversePatches);

            // Simulate coordinator emitting rollback
            mockCoordinatorInstance.__mockEmit('onRollback', rollbackMap);

            // Verify applyImmerPatches was called by the rollback handler
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            // It should apply inverse patches to the *current* data of the target atom
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(
                targetAtom.get().data, // Current data of the target atom
                mockInversePatches
            );

            // Verify the target atom's data was updated by the mock applyImmerPatches
            expect(targetAtom.get().data).toEqual({
                id: '1',
                title: 'Initial Target', // From mockInversePatches
                __appliedOptimistic: true // From mock applyImmerPatches
            });
        });

         it('should ignore rollbacks for different atom keys', () => {
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set('another/key', mockInversePatches);

            mockCoordinatorInstance.__mockEmit('onRollback', rollbackMap);

            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled();
        });

        it('should set mutation state to error if rollback application fails', () => {
            const rollbackError = new Error('Rollback apply failed');
            vi.mocked(applyImmerPatches).mockImplementation(() => { throw rollbackError; });

            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set(targetAtomKey, mockInversePatches);

            const mutationAtom = mutation(clientAtom, clientGetter, defaultPath, [], defaultOptions);
            // simulateMount(mutationAtom); // Ensure listener is attached

            mockCoordinatorInstance.__mockEmit('onRollback', rollbackMap);

            // Check mutation atom state (should reflect the error from the handler)
            const state = mutationAtom.get();
            expect(state.status).toBe('error');
            expect(state.error).toBe(rollbackError);
        });
    });

    // TODO: Add tests for effect() helper function itself?

});