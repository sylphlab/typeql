import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import { map, atom, type MapStore, type Atom, onMount, task, type ReadableAtom, type Store } from 'nanostores'; // Use actual map/atom for testing interactions
// Use Operation from fast-json-patch
import { applyPatch, type Operation } from 'fast-json-patch';

import { query, type QueryOptions, type QueryAtom, type QueryMapState, type ProcedureClientPathSelector } from './query'; // Function under test, import new types
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta, CoordinatorEvents } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
// Remove patchUtils and stateUtils imports
// import { applyImmerPatches } from './patchUtils';
// import { applyJsonDelta } from './stateUtils';

// Local definition as workaround for import issues - REMOVE, use imported Operation
/*
interface PatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: any;
  from?: string;
}
*/


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
            // Return Operation[]
            getPendingPatches: vi.fn(() => new Map<AtomKey, Operation[]>()),
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

// Mock fast-json-patch
vi.mock('fast-json-patch', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        applyPatch: vi.fn((base, patches) => {
            console.log('[Mock applyPatch] Applying:', patches, 'to base:', base);
            // Simulate applying patch - return a modified object for testing
            const newDoc = structuredClone(base); // Clone before applying mock effect
            if (patches.length > 0 && typeof newDoc === 'object' && newDoc !== null) {
                 // Add a marker to indicate patch was applied by mock
                 // Use different markers for optimistic vs delta if needed
                 newDoc.__appliedPatch = true;
            }
            // Cast return to 'any' to bypass potential mock type inference issues
            return { newDocument: newDoc } as any;
        }),
    };
});

// Remove mocks for patchUtils and stateUtils
// vi.mock('./patchUtils', () => ({ ... }));
// vi.mock('./stateUtils', () => ({ ... }));

// Remove Nanostores mock entirely - let tests use actual implementation
// vi.mock('nanostores', async (importOriginal) => { ... });

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

        // Register mock client atom using the *actual* (but mocked) registerAtom
        // This ensures it uses the mock's internal store
        const { registerAtom: mockRegisterAtom } = await import('../utils/atomRegistry');
        mockRegisterAtom('zenQueryClient', atom(mockClient));

        mockQueryProcedure.mockReset();
        // vi.resetAllMocks() should handle resetting these. Remove specific .mockClear() calls.
// vi.mocked(generateAtomKey).mockClear();
// vi.mocked(registerAtom).mockClear(); // REMOVE - Interferes with mock implementation
// vi.mocked(unregisterAtom).mockClear();
// vi.mocked(getAtom).mockClear(); // REMOVE - Interferes with mock implementation
        // vi.mocked(applyImmerPatches).mockClear();
        // vi.mocked(applyJsonDelta).mockClear();
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
    // Update type usage: Remove TClient generic argument
    const mockProcedureSelector: ProcedureClientPathSelector<{ query: Mock }> = (
        get: <TValue>(atom: ReadableAtom<TValue> | Store<TValue>) => TValue
    ) => {
        // Ensure the mock returns the exact structure expected by the refactored query helper
        const procedure = {
            query: mockQueryProcedure
        };
        return {
            path: defaultPath, // Path string
            procedure: procedure, // Procedure object containing the method
            _isZenQueryProcedure: true // Marker
        };
    };


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
            mockQueryProcedure.mockResolvedValue(fetchedData); // Resolves immediately
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom); // Triggers fetch

            // Wait for the status update which happens after the promise resolves
            await vi.waitFor(() => {
                expect(queryAtom.get().status).toBe('success');
            });
            expect(queryAtom.get().loading).toBe(false); // Should be false now
            expect(queryAtom.get().data).toEqual(fetchedData);
            expect(queryAtom.get().error).toBeNull();
        });

        it('should set error and error status on failed fetch', async () => {
            const fetchError = new Error('Network Failed');
            mockQueryProcedure.mockRejectedValue(fetchError); // Rejects immediately
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions);
            simulateMount(queryAtom); // Triggers fetch

            // Wait for the status update which happens after the promise rejects
            await vi.waitFor(() => {
                expect(queryAtom.get().status).toBe('error');
            });
            expect(queryAtom.get().loading).toBe(false); // Should be false now
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
            simulateMount(queryAtom); // Ensure mount before checking state

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
            simulateMount(queryAtom); // Ensure mount before reload

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(1));
            expect(queryAtom.get().loading).toBe(true); // Still loading from initial fetch

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
            simulateMount(queryAtom); // Ensure mount before reload

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(1));
            expect(queryAtom.get().loading).toBe(true); // Still loading from initial fetch

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
        // Use Operation format
        const optimisticPatch: Operation[] = [{ op: 'replace', path: '/title', value: 'Optimistic Update' }];
        // Update expected data based on applyPatch mock
        const expectedOptimisticData = { id: '123', title: 'Initial', __appliedPatch: true };

        beforeEach(() => {
            mockQueryProcedure.mockResolvedValue(initialData);
        });

        it('should apply pending patches from coordinator on onStateChange', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            const pendingPatchesMap = new Map<AtomKey, Operation[]>(); // Use Operation[]
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap); // No need for 'as any'

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            // Check applyPatch mock
            const { applyPatch: mockApplyPatch } = await import('fast-json-patch');
            expect(vi.mocked(mockApplyPatch)).toHaveBeenCalledTimes(1);
            // applyPatch receives cloned data
            expect(vi.mocked(mockApplyPatch)).toHaveBeenCalledWith(expect.objectContaining(initialData), optimisticPatch, true, false);

            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
            expect(queryAtom.get().status).toBe('success');
        });

        it('should use confirmedServerData as base for optimistic updates', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, defaultOptions); // No initial data
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            const pendingPatchesMap = new Map<AtomKey, Operation[]>(); // Use Operation[]
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            const { applyPatch: mockApplyPatch } = await import('fast-json-patch');
            expect(vi.mocked(mockApplyPatch)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(mockApplyPatch)).toHaveBeenCalledWith(expect.objectContaining(initialData), optimisticPatch, true, false); // initialData is set after fetch
            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
        });

        it('should do nothing if no pending patches for this atom', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => new Map());
            const { applyPatch: mockApplyPatch } = await import('fast-json-patch');
            vi.mocked(mockApplyPatch).mockClear();

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(mockApplyPatch)).not.toHaveBeenCalled();
            expect(queryAtom.get().data).toEqual(initialData);
        });

        it('should handle errors during optimistic patch application', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            const patchError = new Error('Patch application failed');
            const { applyPatch: mockApplyPatch } = await import('fast-json-patch');
            vi.mocked(mockApplyPatch).mockImplementation(() => { throw patchError; });

            const pendingPatchesMap = new Map<AtomKey, Operation[]>(); // Use Operation[]
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap);

            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(mockApplyPatch)).toHaveBeenCalledTimes(1);
            expect(queryAtom.get().status).toBe('error');
            expect(queryAtom.get().error).toBe(patchError);
            expect(queryAtom.get().data).toEqual(initialData);
        });

         it('should clear computation error if subsequent computation succeeds', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            const patchError = new Error('Patch application failed');
            const pendingPatchesMap = new Map<AtomKey, Operation[]>(); // Use Operation[]
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap);

            const { applyPatch: mockApplyPatch } = await import('fast-json-patch');
            vi.mocked(mockApplyPatch).mockImplementationOnce(() => { throw patchError; });
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');
            expect(queryAtom.get().status).toBe('error');
            expect(queryAtom.get().error).toBe(patchError);

            // Mock successful application, casting return to 'any'
            vi.mocked(mockApplyPatch).mockImplementationOnce(() => ({ newDocument: expectedOptimisticData } as any));
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(queryAtom.get().status).toBe('success'); // Status should recover
            expect(queryAtom.get().error).toBeNull();
            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
        });
    });

    describe('Server Deltas (onApplyDelta)', () => {
        const initialData = { id: '123', title: 'Initial', version: 1 };
        const serverDeltaPatch: Operation[] = [{ op: 'replace', path: '/title', value: 'Server Update' }, { op: 'replace', path: '/version', value: 2 }];
        // Update expected data based on applyPatch mock
        const expectedDeltaAppliedData = { ...initialData, title: 'Server Update', version: 2, __appliedPatch: true };
        const expectedOptimisticAfterDelta = { ...expectedDeltaAppliedData, __appliedPatch: true }; // applyPatch mock used for both

        beforeEach(() => {
            mockQueryProcedure.mockResolvedValue(initialData);
        });

        it('should apply server delta patches to confirmed state and recompute optimistic state', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            const { applyPatch: mockApplyPatch } = await import('fast-json-patch');
            vi.mocked(mockApplyPatch).mockClear();

            const serverDelta: ServerDelta = {
                serverSeq: 1,
                key: defaultAtomKey,
                patches: serverDeltaPatch,
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            // Check applyPatch mock (called twice: once for delta, once for optimistic recompute)
            expect(vi.mocked(mockApplyPatch)).toHaveBeenCalledTimes(2);
            // First call applies the delta to initialData
            expect(vi.mocked(mockApplyPatch)).toHaveBeenNthCalledWith(1, expect.objectContaining(initialData), serverDeltaPatch, true, false);
            // Second call recomputes optimistic state (base is now delta-applied data, patches are [])
            expect(vi.mocked(mockApplyPatch)).toHaveBeenNthCalledWith(2, expect.objectContaining(expectedDeltaAppliedData), [], true, false);

            expect(queryAtom.get().data).toEqual(expectedOptimisticAfterDelta);
            expect(queryAtom.get().status).toBe('success');
        });

        it('should ignore deltas for different atom keys', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            const { applyPatch: mockApplyPatch } = await import('fast-json-patch');
            vi.mocked(mockApplyPatch).mockClear();

            const differentKey = 'different/atom';
            const serverDelta: ServerDelta = {
                serverSeq: 1,
                key: differentKey,
                patches: serverDeltaPatch as Operation[], // Cast to Operation[]
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(mockApplyPatch)).not.toHaveBeenCalled();
            expect(queryAtom.get().data).toEqual(initialData);
        });

        it('should handle errors during delta application', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            const deltaError = new Error('Delta application failed');
            const { applyPatch: mockApplyPatch } = await import('fast-json-patch');
            // Mock first call (delta application) to throw
            vi.mocked(mockApplyPatch).mockImplementationOnce(() => { throw deltaError; });

            const serverDelta: ServerDelta = {
                serverSeq: 1,
                key: defaultAtomKey,
                patches: serverDeltaPatch as Operation[], // Cast to Operation[]
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(mockApplyPatch)).toHaveBeenCalledTimes(1); // Only called once before erroring
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
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            mockQueryProcedure.mockResolvedValueOnce(reloadData); // Set up for reload

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
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

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
             simulateMount(queryAtom); // Mount to register atom etc.
             expect(queryAtom.get().status).toBe('idle'); // Should remain idle

             mockQueryProcedure.mockClear(); // Clear any potential calls from other tests

             await queryAtom.reload();

             expect(mockQueryProcedure).not.toHaveBeenCalled();
             expect(queryAtom.get().status).toBe('idle');
             expect(queryAtom.get().loading).toBe(false);
        });

         it('should not fetch if component is unmounted', async () => {
            // Update query call
            const queryAtom = query(mockProcedureSelector, { ...defaultOptions, initialData });
            // Resolve initial fetch immediately
            mockQueryProcedure.mockResolvedValue(initialData);
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            simulateUnmount(queryAtom); // Unmount *before* reload

            mockQueryProcedure.mockClear();

            await queryAtom.reload();

            expect(mockQueryProcedure).not.toHaveBeenCalled();
            expect(queryAtom.get().status).toBe('success'); // State remains as before unmount
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toEqual(initialData);
        });
    });

});