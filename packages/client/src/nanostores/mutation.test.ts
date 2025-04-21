import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import { map, atom, type MapStore, type Atom, onMount, task, type ReadableAtom, type Store, type WritableAtom, get } from 'nanostores'; // Import WritableAtom, Restore get
// Remove import from @nanostores/core
import type { Patch, Draft } from 'immer';
// import type { Operation as PatchOperation } from 'fast-json-patch'; // Not directly used here

// Import ProcedureClientPathSelector from query.ts
import { mutation, effect, type MutationOptions, type MutationAtom, type MutationAtomState, type MutationEffect } from './mutation'; // Function under test
import { type ProcedureClientPathSelector } from './query'; // Import selector type
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta, CoordinatorEvents } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey, type AtomRegistryEntry } from '../utils/atomRegistry'; // Import AtomRegistryEntry
import { applyImmerPatches, produceImmerPatches } from './patchUtils'; // Need produceImmerPatches

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
            generateClientSeq: vi.fn(() => Date.now()),
            registerPendingMutation: vi.fn(),
            getPendingPatches: vi.fn(() => new Map<AtomKey, Patch[]>()),
            __mockEmit: mockEmitter.emit,
            __mockClearListeners: mockEmitter.clearListeners,
        };
        return instance as any;
    });
    return { OptimisticSyncCoordinator: MockCoordinator };
});

// Mock Client (Keep mutation mock)
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

// Mock Atom Registry (Update mockAtomStore type and getAtom return cast)
// Use WritableAtom as the value type to satisfy AtomRegistryEntry expectation
const mockAtomStore: Record<AtomKey, WritableAtom<any>> = {};
vi.mock('../utils/atomRegistry', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        generateAtomKey: vi.fn((path, input) => JSON.stringify({ path, input })),
        // Ensure registerAtom stores the atom correctly
        registerAtom: vi.fn((key, atomInstance: WritableAtom<any>) => { mockAtomStore[key] = atomInstance; }),
        unregisterAtom: vi.fn((key) => { delete mockAtomStore[key]; }),
        // Cast the return type to match AtomRegistryEntry (assuming it's compatible with WritableAtom)
        getAtom: vi.fn((key): WritableAtom<any> | undefined => mockAtomStore[key]),
    };
});

// Mock Patch Utils (Keep as is)
vi.mock('./patchUtils', () => ({
    applyImmerPatches: vi.fn((base, patches) => {
        console.log('[Mock applyImmerPatches] Applying:', patches, 'to base:', base);
        let newState = structuredClone(base);
        if (patches.length > 0 && typeof newState === 'object' && newState !== null) {
             patches.forEach((patch: Patch) => {
                if (patch.op === 'replace' && patch.path.length === 1 && patch.path[0] === 'content') {
                    newState.content = patch.value;
                } else if (patch.op === 'add' && patch.path.length === 1 && patch.path[0] === 'title') {
                     newState.title = patch.value;
                }
             });
            newState.__appliedOptimistic = true;
        }
        return newState;
    }),
    produceImmerPatches: vi.fn((base, recipe) => {
        console.log('[Mock produceImmerPatches] Producing for base:', base);
        const mockPatches: Patch[] = [{ op: 'replace', path: ['title'], value: 'Optimistic Mock Title' }];
        const mockInversePatches: Patch[] = [{ op: 'replace', path: ['title'], value: base?.title ?? 'Original Mock Title' }];
        const nextState = { ...(base ?? {}), title: 'Optimistic Mock Title', __appliedOptimistic: true };
        return [nextState, mockPatches, mockInversePatches];
    }),
}));

// Remove Nanostores mock entirely - let tests use actual implementation
// vi.mock('nanostores', async (importOriginal) => { ... });

// --- Test Suite ---

describe('Nanostores mutation() helper', () => {
    // Remove clientAtom, clientGetter
    let mockCoordinatorInstance: OptimisticSyncCoordinator & { __mockEmit: Function };
    // Adjust targetAtom type
    type TargetAtomState = { data: { id: string; title: string } | undefined, status: string, error: any };
    // Ensure targetAtom is Writable
    let targetAtom: MapStore<TargetAtomState> & { readonly key: AtomKey };
    const targetAtomKey = 'target/atom';

    // Helpers (Keep as is)
    const simulateMount = (atomInstance: Atom<any>) => { /* ... */ };
    const simulateUnmount = (atomInstance: Atom<any>) => { /* ... */ };

    beforeEach(async () => {
        vi.clearAllMocks();
        Object.keys(mockAtomStore).forEach(key => delete mockAtomStore[key]);

        const { OptimisticSyncCoordinator: MockCoordinator } = await import('../coordinator');
        mockCoordinatorInstance = new MockCoordinator() as OptimisticSyncCoordinator & { __mockEmit: Function };
        (mockCoordinatorInstance as any).__mockClearListeners?.();
        vi.mocked(mockClient.getCoordinator).mockReturnValue(mockCoordinatorInstance as any);

        mockMutateProcedure.mockReset();
        vi.mocked(generateAtomKey).mockClear();
        vi.mocked(registerAtom).mockClear();
        vi.mocked(unregisterAtom).mockClear();
        // Ensure getAtom mock uses the updated store/return type
        vi.mocked(getAtom).mockClear().mockImplementation((key): WritableAtom<any> | undefined => mockAtomStore[key]);
        vi.mocked(applyImmerPatches).mockClear();
        vi.mocked(produceImmerPatches).mockClear();
        // Remove mockClear for Nanostores functions
        // vi.mocked(onMount).mockClear();
        // vi.mocked(task).mockClear();

        // Recreate mock target atom correctly (MapStore is Writable)
        const mapStore = map<TargetAtomState>({ data: { id: '1', title: 'Initial Target' }, status: 'success', error: null });
        targetAtom = Object.assign(mapStore, { key: targetAtomKey }) as typeof targetAtom;
        mockAtomStore[targetAtomKey] = targetAtom; // Register mock atom

    });

    // Remove clientGetter
    const defaultPath = 'posts.create';
    const defaultInput = { title: 'New Post', content: 'Hello' };
    // Update defaultOptions: remove effectsArray as direct arg, add empty options object
    const defaultOptions: MutationOptions<any, any, typeof defaultInput> = {};

    // Define mock procedure selector for mutation
    // Update type usage: Remove TClient generic argument
    const mockProcedureSelector: ProcedureClientPathSelector<{ mutate: Mock }> = (
        get: <TValue>(atom: ReadableAtom<TValue> | Store<TValue>) => TValue
    ) => {
        // Ensure the mock returns the exact structure expected by the refactored helper
        const procedure = {
            mutate: mockMutateProcedure
        };
        return {
            path: defaultPath, // Path string
            procedure: procedure, // Procedure object containing the method
            _isZenQueryProcedure: true // Marker
        };
    };
  
  
    // --- Test Cases ---

    it('should initialize with correct default state', () => {
        // Update mutation call: remove clientAtom, clientGetter, path, effectsArray
        const mutationAtom = mutation(mockProcedureSelector, defaultOptions);
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
             vi.mocked(produceImmerPatches).mockReturnValue([
                { id: '1', title: 'Optimistic Mock Title', __appliedOptimistic: true },
                mockPatches,
                mockInversePatches
            ]);
        });

        it('should set loading state and variables immediately', async () => {
            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, defaultOptions);
            simulateMount(mutationAtom); // Ensure mount before mutate
            // Wrap mutate call in task to ensure onMount completes
            const mutatePromise = task(() => mutationAtom.mutate(mutationVariables));


            const state = mutationAtom.get();
            // State might not be loading immediately if task hasn't run, adjust assertion or wait
            // Let's assume we check state *after* the task starts
            // await new Promise(setImmediate); // Or similar microtask delay if needed
            expect(state.loading).toBe(true);
            expect(state.status).toBe('loading');
            expect(state.variables).toEqual(mutationVariables);
            expect(state.error).toBeNull();
            expect(state.data).toBeUndefined();

            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });

        it('should call produceImmerPatches for each effect in options.effects', async () => {
            const effect1Recipe = vi.fn();
            const effect2Recipe = vi.fn();
            const effect1 = effect(targetAtom, effect1Recipe);
            const effect2 = effect(targetAtom, effect2Recipe);
            // Pass effects via options
            const optionsWithEffects: MutationOptions<any, any, typeof mutationVariables> = { effects: [effect1, effect2] };

            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, optionsWithEffects);
            simulateMount(mutationAtom); // Ensure mount before mutate
            // Wrap mutate call in task
            const mutatePromise = task(() => mutationAtom.mutate(mutationVariables));


            expect(vi.mocked(produceImmerPatches)).toHaveBeenCalledTimes(2);
            expect(vi.mocked(produceImmerPatches)).toHaveBeenCalledWith(targetAtom.get().data, expect.any(Function));

            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });

         it('should update target atom data based on produceImmerPatches result', async () => {
            const effectRecipe = vi.fn();
            const testEffect = effect(targetAtom, effectRecipe);
            const expectedNextState = { id: '1', title: 'Optimistic Mock Title', __appliedOptimistic: true };
            // Pass effect via options
            const optionsWithEffect: MutationOptions<any, any, typeof mutationVariables> = { effects: [testEffect] };

            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, optionsWithEffect);
            simulateMount(mutationAtom); // Ensure mount before mutate
            // Wrap mutate call in task
            const mutatePromise = task(() => mutationAtom.mutate(mutationVariables));


            expect(vi.mocked(produceImmerPatches)).toHaveBeenCalledTimes(1);
            expect(targetAtom.get().data).toEqual(expectedNextState);

            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });


        it('should call coordinator.registerPendingMutation with generated patches', async () => {
            const effectRecipe = vi.fn();
            const testEffect = effect(targetAtom, effectRecipe);
            // Pass effect via options
            const optionsWithEffect: MutationOptions<any, any, typeof mutationVariables> = { effects: [testEffect] };

            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, optionsWithEffect);
            simulateMount(mutationAtom); // Ensure mount before mutate
            // Wrap mutate call in task
            const mutatePromise = task(() => mutationAtom.mutate(mutationVariables));


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

            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });

        it('should call the correct client mutation procedure', async () => {
            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, defaultOptions);
            simulateMount(mutationAtom); // Ensure mount before mutate
            // Wrap mutate call in task
            const mutatePromise = task(() => mutationAtom.mutate(mutationVariables));


            expect(mockMutateProcedure).toHaveBeenCalledTimes(1);
            expect(mockMutateProcedure).toHaveBeenCalledWith({
                input: mutationVariables,
                clientSeq: mockClientSeq,
            });

            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);
            await mutatePromise;
        });

        it('should resolve promise and set success state on coordinator onAck', async () => {
            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, defaultOptions);
            simulateMount(mutationAtom); // Ensure mount before mutate
            // Wrap mutate call in task
            const mutatePromise = task(() => mutationAtom.mutate(mutationVariables));


            mockCoordinatorInstance.__mockEmit('onAck', mockClientSeq, mockServerResult);

            await expect(mutatePromise).resolves.toEqual(mockServerResult);

            const state = mutationAtom.get();
            expect(state.loading).toBe(false);
            expect(state.status).toBe('success');
            expect(state.data).toEqual(mockServerResult);
            expect(state.error).toBeNull();
            expect(state.variables).toEqual(mutationVariables);
        });

        it('should reject promise and set error state on coordinator onError', async () => {
            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, defaultOptions);
            simulateMount(mutationAtom); // Ensure mount before mutate
            // Wrap mutate call in task
            const mutatePromise = task(() => mutationAtom.mutate(mutationVariables));

            const mutationError = new Error('Server Rejected Mutation');

            mockCoordinatorInstance.__mockEmit('onError', mockClientSeq, mutationError);

            await expect(mutatePromise).rejects.toThrow('Server Rejected Mutation');

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
            // Pass effect via options
            const optionsWithEffect: MutationOptions<any, any, typeof mutationVariables> = { effects: [testEffect] };

            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, optionsWithEffect);
            simulateMount(mutationAtom); // Ensure mount before mutate

            // Wrap mutate call in task and await the task's promise
            await expect(task(() => mutationAtom.mutate(mutationVariables))).rejects.toThrow('Failed applying optimistic effect');


            const state = mutationAtom.get();
            expect(state.loading).toBe(false);
            expect(state.status).toBe('error');
            expect(state.error).toEqual(optimisticError);
            expect(state.data).toBeUndefined();
            expect(state.variables).toEqual(mutationVariables);

            expect(mockMutateProcedure).not.toHaveBeenCalled();
            expect(vi.mocked(mockCoordinatorInstance.registerPendingMutation)).not.toHaveBeenCalled();
        });

         it('should handle errors during client procedure invocation', async () => {
            const invocationError = new Error('Procedure not found');
            mockMutateProcedure.mockImplementation(() => { throw invocationError; });

            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, defaultOptions);
            simulateMount(mutationAtom); // Ensure mount before mutate

            // Wrap mutate call in task and await the task's promise
            await expect(task(() => mutationAtom.mutate(mutationVariables))).rejects.toThrow('Procedure not found');


            const state = mutationAtom.get();
            expect(state.loading).toBe(false);
            expect(state.status).toBe('error');
            expect(state.error).toEqual(invocationError);
            expect(state.data).toBeUndefined();
            expect(state.variables).toEqual(mutationVariables);

             expect(vi.mocked(mockCoordinatorInstance.registerPendingMutation)).toHaveBeenCalledTimes(1);
        });

    });

    describe('Coordinator Rollback Handling', () => {
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
            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, defaultOptions);
            simulateMount(mutationAtom); // Add mount simulation here
            vi.mocked(applyImmerPatches).mockClear();
        });

        it('should call applyImmerPatches with inverse patches on onRollback', () => {
            const rollbackMap = new Map<AtomKey, Patch[]>();
            rollbackMap.set(targetAtomKey, mockInversePatches);

            mockCoordinatorInstance.__mockEmit('onRollback', rollbackMap);

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(
                targetAtom.get().data,
                mockInversePatches
            );

            expect(targetAtom.get().data).toEqual({
                id: '1',
                title: 'Initial Target', // From mockInversePatches via mock applyImmerPatches
                __appliedOptimistic: true
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

            // Update mutation call
            const mutationAtom = mutation(mockProcedureSelector, defaultOptions);
            simulateMount(mutationAtom); // Add mount simulation here too
            mockCoordinatorInstance.__mockEmit('onRollback', rollbackMap);


            const state = mutationAtom.get();
            expect(state.status).toBe('error');
            expect(state.error).toBe(rollbackError);
        });
    });

});