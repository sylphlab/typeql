import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import { map, atom, type MapStore, type Atom, onMount, task, type ReadableAtom, type Store } from 'nanostores'; // Use actual map/atom for testing interactions
import type { Patch } from 'immer';
// import { Operation } from 'fast-json-patch'; // Use named import - Replaced with local interface

import { query, type QueryOptions, type QueryAtom, type QueryMapState, type ProcedureClientPathSelector } from './query'; // Function under test, import new types
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

// Mock Client (Keep as is)
const mockQueryProcedure = vi.fn();
const mockClient = {
    query: {
        posts: {
            get: {
                query: mockQueryProcedure,
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
    produceImmerPatches: vi.fn(),
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
        onMount: vi.fn((
            store: import('nanostores').Store,
            initialize?: (payload?: { shared?: any }) => void | (() => void)
        ) => {
            const storeWithMocks = store as any;
            if (!storeWithMocks.__mockMountCallbacks) storeWithMocks.__mockMountCallbacks = [];
            storeWithMocks.__mockMountCallbacks.push(initialize);
            return () => {};
        }),
    };
});

// --- Test Suite ---

describe('Nanostores query() helper', () => {
    // Remove clientAtom and clientGetter
    let mockCoordinatorInstance: OptimisticSyncCoordinator;
    let capturedUnmount: (() => void) | void | undefined;

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

        mockQueryProcedure.mockReset();
        vi.mocked(generateAtomKey).mockClear();
        vi.mocked(registerAtom).mockClear();
        vi.mocked(unregisterAtom).mockClear();
        vi.mocked(getAtom).mockClear();
        vi.mocked(applyImmerPatches).mockClear();
        vi.mocked(applyJsonDelta).mockClear();
        vi.mocked(map).mockClear();
        vi.mocked(onMount).mockClear();
        vi.mocked(task).mockClear();
        capturedUnmount = undefined;
    });

    afterEach(() => {
        // Keep cleanup logic
    });

    const defaultPath = 'posts.get';
    const defaultInput = { id: '123' };
    // Update defaultOptions: remove path
    const defaultOptions: QueryOptions<typeof defaultInput, { id: string; title: string }> = {
        input: defaultInput,
    };
    const defaultAtomKey = JSON.stringify({ path: defaultPath, input: defaultInput });

    // Define mock procedure selector
    // Add type for 'get' parameter and explicitly type the procedure return
    // Use 'as any' assertion to bypass incorrect type inference on posts
    const mockProcedureSelector: ProcedureClientPathSelector<ZenQueryClient, { query: Mock }> = (
        get: <TValue>(atom: ReadableAtom<TValue> | Store<TValue>) => TValue
    ) => ({
        client: mockClient, // Use the mock client
        procedure: (mockClient.query.posts as any).get, // Use 'as any' here
        path: defaultPath, // Provide the path
    });


    // --- Test Cases ---

    it('should initialize with correct default state (enabled: true)', () => {
        // Update query call
        const queryAtom = query(mockProcedureSelector, defaultOptions);
        const initialState = queryAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.loading).toBe(true);
        expect(initialState.error).toBeNull();
        expect(initialState.status).toBe('loading');
        // generateAtomKey is now called with path from selector result
        expect(vi.mocked(generateAtomKey)).toHaveBeenCalledWith(defaultPath, defaultInput);
        expect(queryAtom.key).toBe(defaultAtomKey);
    });

    it('should initialize with correct default state (enabled: false)', () => {
        // Update query call
        const queryAtom = query(mockProcedureSelector, { ...defaultOptions, enabled: false });
        const initialState = queryAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.loading).toBe(false);
        expect(initialState.error).toBeNull();
        expect(initialState.status).toBe('idle');
    });

     it('should initialize with initialData', () => {
        const initialData = { id: '123', title: 'Initial Title' };
        // Update query call
        const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
        const initialState = queryAtom.get();

        expect(initialState.data).toEqual(initialData);
        expect(initialState.loading).toBe(true);
        expect(initialState.error).toBeNull();
        expect(initialState.status).toBe('loading');
    });

    describe('onMount', () => {
        it('should register the atom with the registry', () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);

            expect(vi.mocked(registerAtom)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(registerAtom)).toHaveBeenCalledWith(defaultAtomKey, queryAtom);
        });

        it('should subscribe to coordinator events (onStateChange, onApplyDelta)', () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);

            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onStateChange', expect.any(Function));
            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onApplyDelta', expect.any(Function));
        });

        it('should call fetcher immediately if enabled and no initialData', async () => {
            mockQueryProcedure.mockResolvedValue({ id: '123', title: 'Fetched Title' });
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);

            expect(queryAtom.get().status).toBe('loading');
            expect(queryAtom.get().loading).toBe(true);

            simulateMount(queryAtom);

            await vi.waitFor(() => {
                expect(mockQueryProcedure).toHaveBeenCalledTimes(1);
            });
            // Input is now passed from options within fetcher
            expect(mockQueryProcedure).toHaveBeenCalledWith(defaultInput, { signal: expect.any(AbortSignal) });

            await vi.waitFor(() => {
                expect(queryAtom.get().status).toBe('success');
            });
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toEqual({ id: '123', title: 'Fetched Title' });
            expect(queryAtom.get().error).toBeNull();
        });

        it('should call fetcher immediately if enabled and has initialData (SWR)', async () => {
            const initialData = { id: '123', title: 'Initial Title' };
            mockQueryProcedure.mockResolvedValue({ id: '123', title: 'Fetched Title' });
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });

            expect(queryAtom.get().status).toBe('loading');
            expect(queryAtom.get().loading).toBe(true);
            expect(queryAtom.get().data).toEqual(initialData);

            simulateMount(queryAtom);

            await vi.waitFor(() => {
                expect(mockQueryProcedure).toHaveBeenCalledTimes(1);
            });
            expect(mockQueryProcedure).toHaveBeenCalledWith(defaultInput, { signal: expect.any(AbortSignal) });

            await vi.waitFor(() => {
                expect(queryAtom.get().status).toBe('success');
            });
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toEqual({ id: '123', title: 'Fetched Title' });
            expect(queryAtom.get().error).toBeNull();
        });

        it('should NOT call fetcher if enabled: false', () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, enabled: false });
            simulateMount(queryAtom);

            expect(mockQueryProcedure).not.toHaveBeenCalled();
            expect(queryAtom.get().status).toBe('idle');
            expect(queryAtom.get().loading).toBe(false);
        });

        it('should unregister atom and unsubscribe from coordinator on unmount', () => {
            const mockUnsubChange = vi.fn();
            const mockUnsubDelta = vi.fn();
            vi.mocked(mockCoordinatorInstance.on)
                .mockImplementationOnce((event, cb) => mockUnsubChange) // onStateChange
                .mockImplementationOnce((event, cb) => mockUnsubDelta); // onApplyDelta

            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);
            simulateUnmount(queryAtom);

            expect(vi.mocked(unregisterAtom)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(unregisterAtom)).toHaveBeenCalledWith(defaultAtomKey);
            expect(mockUnsubChange).toHaveBeenCalledTimes(1);
            expect(mockUnsubDelta).toHaveBeenCalledTimes(1);
        });

        it('should abort ongoing fetch on unmount', async () => {
            const abortController = new AbortController();
            const signal = abortController.signal;
            const abortSpy = vi.spyOn(abortController, 'abort');

            const neverResolves = new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
            mockQueryProcedure.mockImplementation(async ({ signal: fetchSignal }) => { // Destructure signal from argument
                 fetchSignal.addEventListener('abort', () => abortController.abort());
                 return neverResolves;
            });


            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);

            expect(mockQueryProcedure).toHaveBeenCalledTimes(1);
            expect(queryAtom.get().loading).toBe(true);

            simulateUnmount(queryAtom);

            await vi.waitFor(() => {
                 expect(queryAtom.get().loading).toBe(false);
                 expect(queryAtom.get().status).toBe('idle');
            });
        });

    });

    describe('Fetching Logic', () => {
        it('should set data and success status on successful fetch', async () => {
            const fetchedData = { id: '123', title: 'Fetched OK' };
            mockQueryProcedure.mockResolvedValue(fetchedData);
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);

            await vi.waitFor(() => {
                expect(queryAtom.get().status).toBe('success');
            });
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toEqual(fetchedData);
            expect(queryAtom.get().error).toBeNull();
        });

        it('should set error and error status on failed fetch', async () => {
            const fetchError = new Error('Network Failed');
            mockQueryProcedure.mockRejectedValue(fetchError);
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);

            await vi.waitFor(() => {
                expect(queryAtom.get().status).toBe('error');
            });
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toBeUndefined();
            expect(queryAtom.get().error).toBe(fetchError);
        });

        it('should handle fetch abortion correctly', async () => {
            let externalAbortController = new AbortController();
            const abortError = new DOMException('Aborted', 'AbortError');

            mockQueryProcedure.mockImplementation(async ({ signal }) => { // Destructure signal
                return new Promise((resolve, reject) => {
                    const onAbort = () => {
                        clearTimeout(timeoutId);
                        reject(abortError);
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                    const timeoutId = setTimeout(() => {
                        signal.removeEventListener('abort', onAbort);
                        resolve({ id: '123', title: 'Should not resolve' });
                    }, 50);
                });
            });

            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);

            expect(queryAtom.get().loading).toBe(true);
            expect(queryAtom.get().status).toBe('loading');

            simulateUnmount(queryAtom);

            await vi.waitFor(() => {
                expect(queryAtom.get().loading).toBe(false);
            });
            expect(queryAtom.get().status).toBe('idle');
            expect(queryAtom.get().error).toBeNull();
        });

        it('should ignore result from stale fetch if a new fetch was initiated', async () => {
            const firstFetchResult = { id: '123', title: 'First Result (Stale)' };
            const secondFetchResult = { id: '123', title: 'Second Result (Current)' };
            let firstFetchResolve: (value: any) => void;
            let secondFetchResolve: (value: any) => void;

            mockQueryProcedure.mockImplementationOnce(async ({ signal }) => { // Destructure signal
                return new Promise((resolve) => { firstFetchResolve = resolve; });
            });

            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(1));
            expect(queryAtom.get().loading).toBe(true);

            mockQueryProcedure.mockImplementationOnce(async ({ signal }) => { // Destructure signal
                return new Promise((resolve) => { secondFetchResolve = resolve; });
            });
            await queryAtom.reload();

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(2));
            expect(queryAtom.get().loading).toBe(true);

            secondFetchResolve!(secondFetchResult);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));
            expect(queryAtom.get().data).toEqual(secondFetchResult);

            firstFetchResolve!(firstFetchResult);
            await new Promise(res => setTimeout(res, 10));
            expect(queryAtom.get().data).toEqual(secondFetchResult);
            expect(queryAtom.get().status).toBe('success');
            expect(queryAtom.get().loading).toBe(false);
        });

         it('should ignore error from stale fetch if a new fetch was initiated', async () => {
            const secondFetchResult = { id: '123', title: 'Second Result (Current)' };
            const firstFetchError = new Error('First fetch failed (Stale)');
            let firstFetchReject: (reason?: any) => void;
            let secondFetchResolve: (value: any) => void;

            mockQueryProcedure.mockImplementationOnce(async ({ signal }) => { // Destructure signal
                return new Promise((resolve, reject) => { firstFetchReject = reject; });
            });

            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom);

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(1));
            expect(queryAtom.get().loading).toBe(true);

            mockQueryProcedure.mockImplementationOnce(async ({ signal }) => { // Destructure signal
                return new Promise((resolve) => { secondFetchResolve = resolve; });
            });
            await queryAtom.reload();

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(2));
            expect(queryAtom.get().loading).toBe(true);

            secondFetchResolve!(secondFetchResult);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));
            expect(queryAtom.get().data).toEqual(secondFetchResult);
            expect(queryAtom.get().error).toBeNull();

            firstFetchReject!(firstFetchError);
            await new Promise(res => setTimeout(res, 10));
            expect(queryAtom.get().data).toEqual(secondFetchResult);
            expect(queryAtom.get().status).toBe('success');
            expect(queryAtom.get().error).toBeNull();
            expect(queryAtom.get().loading).toBe(false);
        });

    });

    describe('Optimistic Updates (onStateChange)', () => {
        const initialData = { id: '123', title: 'Initial' };
        const optimisticPatch: Patch[] = [{ op: 'replace', path: ['title'], value: 'Optimistic Update' }];
        const expectedOptimisticData = { id: '123', title: 'Optimistic Update', __appliedOptimistic: true };

        beforeEach(() => {
            mockQueryProcedure.mockResolvedValue(initialData);
        });

        it('should apply pending patches from coordinator on onStateChange', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(initialData, optimisticPatch);

            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
            expect(queryAtom.get().status).toBe('success');
        });

        it('should use confirmedServerData as base for optimistic updates', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions); // No initial data
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(initialData, optimisticPatch); // initialData is set after fetch
            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
        });

        it('should do nothing if no pending patches for this atom', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => new Map() as any);
            vi.mocked(applyImmerPatches).mockClear();

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled();
            expect(queryAtom.get().data).toEqual(initialData);
        });

        it('should handle errors during optimistic patch application', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const patchError = new Error('Patch application failed');
            vi.mocked(applyImmerPatches).mockImplementation(() => { throw patchError; });

            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(queryAtom.get().status).toBe('error');
            expect(queryAtom.get().error).toBe(patchError);
            expect(queryAtom.get().data).toEqual(initialData);
        });

         it('should clear computation error if subsequent computation succeeds', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const patchError = new Error('Patch application failed');
            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            vi.mocked(applyImmerPatches).mockImplementationOnce(() => { throw patchError; });
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');
            expect(queryAtom.get().status).toBe('error');
            expect(queryAtom.get().error).toBe(patchError);

            vi.mocked(applyImmerPatches).mockImplementationOnce(() => expectedOptimisticData);
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(queryAtom.get().status).toBe('success');
            expect(queryAtom.get().error).toBeNull();
            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
        });
    });

    describe('Server Deltas (onApplyDelta)', () => {
        const initialData = { id: '123', title: 'Initial', version: 1 };
        const serverDeltaPatch: PatchOperation[] = [{ op: 'replace', path: '/title', value: 'Server Update' }, { op: 'replace', path: '/version', value: 2 }];
        const expectedDeltaAppliedData = { ...initialData, title: 'Server Update', version: 2, __appliedDelta: true };
        const expectedOptimisticAfterDelta = { ...expectedDeltaAppliedData, __appliedOptimistic: true };

        beforeEach(() => {
            mockQueryProcedure.mockResolvedValue(initialData);
        });

        it('should apply server delta patches to confirmed state and recompute optimistic state', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            vi.mocked(applyJsonDelta).mockClear();
            vi.mocked(applyImmerPatches).mockClear();

            const serverDelta: ServerDelta = {
                serverSeq: 1,
                key: defaultAtomKey,
                patches: serverDeltaPatch,
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledWith(initialData, serverDeltaPatch);

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(expectedDeltaAppliedData, []);

            expect(queryAtom.get().data).toEqual(expectedOptimisticAfterDelta);
            expect(queryAtom.get().status).toBe('success');
        });

        it('should ignore deltas for different atom keys', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            vi.mocked(applyJsonDelta).mockClear();

            const differentKey = 'different/atom';
            const serverDelta: ServerDelta = {
                serverSeq: 1,
                key: differentKey,
                patches: serverDeltaPatch,
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(applyJsonDelta)).not.toHaveBeenCalled();
            expect(queryAtom.get().data).toEqual(initialData);
        });

        it('should handle errors during delta application', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const deltaError = new Error('Delta application failed');
            vi.mocked(applyJsonDelta).mockImplementation(() => { throw deltaError; });

            const serverDelta: ServerDelta = {
                serverSeq: 1,
                key: defaultAtomKey,
                patches: serverDeltaPatch,
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledTimes(1);
            expect(queryAtom.get().status).toBe('error');
            expect(queryAtom.get().error).toBe(deltaError);
            expect(queryAtom.get().data).toEqual(initialData);
        });
    });

    describe('reload() function', () => {
        const initialData = { id: '123', title: 'Initial' };
        const reloadData = { id: '123', title: 'Reloaded Data' };

        beforeEach(() => {
            mockQueryProcedure.mockResolvedValueOnce(initialData);
        });

        it('should set loading state and re-fetch data when called', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            mockQueryProcedure.mockResolvedValueOnce(reloadData);

            const reloadPromise = queryAtom.reload();

            expect(queryAtom.get().loading).toBe(true);
            expect(queryAtom.get().status).toBe('loading');
            expect(queryAtom.get().error).toBeNull();
            expect(queryAtom.get().data).toEqual(initialData);

            await reloadPromise;

            expect(mockQueryProcedure).toHaveBeenCalledTimes(2);
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().status).toBe('success');
            expect(queryAtom.get().data).toEqual(reloadData);
            expect(queryAtom.get().error).toBeNull();
        });

        it('should handle errors during reload fetch', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const reloadError = new Error('Reload Failed');
            mockQueryProcedure.mockRejectedValueOnce(reloadError);

            await expect(queryAtom.reload()).rejects.toThrow('Reload Failed');

            expect(mockQueryProcedure).toHaveBeenCalledTimes(2);
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().status).toBe('error');
            expect(queryAtom.get().error).toBe(reloadError);
            expect(queryAtom.get().data).toEqual(initialData);
        });

        it('should not fetch if query is disabled', async () => {
             // Update query call
             const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData, enabled: false });
             simulateMount(queryAtom);
             expect(queryAtom.get().status).toBe('idle');

             mockQueryProcedure.mockClear();

             await queryAtom.reload();

             expect(mockQueryProcedure).not.toHaveBeenCalled();
             expect(queryAtom.get().status).toBe('idle');
             expect(queryAtom.get().loading).toBe(false);
        });

         it('should not fetch if component is unmounted', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            simulateUnmount(queryAtom);

            mockQueryProcedure.mockClear();

            await queryAtom.reload();

            expect(mockQueryProcedure).not.toHaveBeenCalled();
            expect(queryAtom.get().status).toBe('success'); // State remains as before unmount
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toEqual(initialData);
        });
    });

});