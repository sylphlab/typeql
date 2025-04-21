import { describe, it, expect, beforeEach, vi, type Mock, afterEach } from 'vitest';
import { map, atom, type MapStore, type Atom, onMount, task } from 'nanostores'; // Use actual map/atom for testing interactions
import type { Patch } from 'immer';
import type { Operation as PatchOperation } from 'fast-json-patch';

import { query, type QueryOptions, type QueryAtom, type QueryMapState } from './query'; // Function under test
import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, ServerDelta, CoordinatorEvents } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches } from './patchUtils';
import { applyJsonDelta } from './stateUtils';

// --- Mocks ---

// Mock Coordinator
vi.mock('../coordinator', async () => { // Make mock factory async
    // Import the actual type *within* the mock factory
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
        // Helper to clear listeners between tests if needed
        clearListeners: () => { mockEmitter.events = {} as Record<keyof CoordinatorEvents, Function[]>; } // Fix type
    };
    // Return a mock class that adheres to the OptimisticSyncCoordinator structure
    const MockCoordinator = vi.fn().mockImplementation(() => {
        // Return a simplified object containing only the methods used by query.ts
        // Rely on the emitter's 'on' method for event handling.
        const instance = {
            on: mockEmitter.on, // Provide the core 'on' method
            // Correct return type to Immer Patch[] as expected by computeOptimisticState
            getPendingPatches: vi.fn(() => new Map<AtomKey, Patch[]>()),
            // Add other methods if directly called by query.ts
            // generateClientSeq: vi.fn(() => Date.now()), // Not directly called by query
            // registerPendingMutation: vi.fn(), // Not directly called by query
            // confirmMutation: vi.fn(), // Not directly called by query
            // rejectMutation: vi.fn(), // Not directly called by query
            // processServerDelta: vi.fn(), // Not directly called by query
            // getConfirmedServerSeq: vi.fn(() => 0), // Not directly called by query
            // hasPendingMutations: vi.fn(() => false), // Not directly called by query

            // Add helpers for testing
            __mockEmit: mockEmitter.emit,
            __mockClearListeners: mockEmitter.clearListeners,
        };
        // Cast to satisfy the type system where needed, acknowledging it's a mock
        return instance as any; // Use 'any' here to avoid complex type matching issues
    }); // Close mockImplementation

    // Return the factory result correctly
    return {
        OptimisticSyncCoordinator: MockCoordinator,
    };
}); // Close vi.mock factory

// Mock Client
const mockQueryProcedure = vi.fn();
const mockClient = {
    query: {
        posts: {
            get: {
                query: mockQueryProcedure,
            },
        },
        // Add other mock procedures as needed
    },
    getCoordinator: vi.fn(),
} as unknown as ZenQueryClient; // Cast for type checking

// Mock Atom Registry
vi.mock('../utils/atomRegistry', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual, // Keep actual generateAtomKey if needed, or mock it too
        generateAtomKey: vi.fn((path, input) => JSON.stringify({ path, input })), // Simple mock key gen
        registerAtom: vi.fn(),
        unregisterAtom: vi.fn(),
        getAtom: vi.fn(),
    };
});

// Mock Patch Utils (can be simple pass-through or specific mock logic)
vi.mock('./patchUtils', () => ({
    applyImmerPatches: vi.fn((base, patches) => {
        // Simple mock: return base for now, or implement basic patch application if needed
        console.log('[Mock applyImmerPatches] Applying:', patches, 'to base:', base);
        // A more realistic mock might use actual immer applyPatches if installed
        // For simplicity, just return the base or a modified object
        if (patches.length > 0 && typeof base === 'object' && base !== null) {
            return { ...base, __appliedOptimistic: true }; // Mark as applied
        }
        return base;
    }),
    produceImmerPatches: vi.fn(), // Needed by mutation, mock if necessary later
}));

// Mock State Utils
vi.mock('./stateUtils', () => ({
    applyJsonDelta: vi.fn((base, patches) => {
        // Simple mock
        console.log('[Mock applyJsonDelta] Applying:', patches, 'to base:', base);
        if (patches.length > 0 && typeof base === 'object' && base !== null) {
            return { ...base, __appliedDelta: true }; // Mark as applied
        }
        return base;
    }),
}));

// Mock nanostores task and onMount
vi.mock('nanostores', async (importOriginal) => {
    const actual = await importOriginal() as typeof import('nanostores'); // Use actual types
    return {
        ...actual, // Keep original atom, map, etc.
        task: vi.fn((fn) => fn), // task() returns the function itself
        // Mock onMount with correct signature matching nanostores type
        onMount: vi.fn((
            store: import('nanostores').Store,
            initialize?: (payload?: { shared?: any }) => void | (() => void)
        ) => {
            // Store mount callbacks to simulate mount/unmount
            // We attach mock properties directly to the store instance
            const storeWithMocks = store as any;
            if (!storeWithMocks.__mockMountCallbacks) storeWithMocks.__mockMountCallbacks = [];
            storeWithMocks.__mockMountCallbacks.push(initialize); // Store the initializer

            // Return the standard nanostores unsubscribe function
            return () => {
                // This function is called by nanostores when the last listener unsubscribes
                // We can potentially trigger our simulated unmount logic here if needed,
                // but the explicit simulateUnmount helper is clearer for tests.
            };
        }),
    };
});

// --- Test Suite ---

describe('Nanostores query() helper', () => {
    let clientAtom: Atom<ZenQueryClient>;
    let mockCoordinatorInstance: OptimisticSyncCoordinator;
    // mockMapStore is not needed as query() creates its own internal map
    // let mockMapStore: MapStore<QueryMapState<any, any>> & { __mockMountCallbacks?: Array<() => void | (() => void)>, __mockUnmount?: () => void };
    let capturedUnmount: (() => void) | void | undefined;

    // Helper to simulate mounting by calling the stored initializer attached by the mock onMount
    const simulateMount = (atomInstance: Atom<any>) => { // Accept any Store type
        const instanceWithMocks = atomInstance as any;
        if (instanceWithMocks.__mockMountCallbacks && instanceWithMocks.__mockMountCallbacks.length > 0) {
            const initialize = instanceWithMocks.__mockMountCallbacks[instanceWithMocks.__mockMountCallbacks.length - 1];
            if (typeof initialize === 'function') {
                const unmountFn = initialize(); // Execute the initializer
                if (typeof unmountFn === 'function') {
                    instanceWithMocks.__mockUnmount = unmountFn; // Store the returned unmount function
                }
            }
        }
    };

    // Helper to simulate unmounting by calling the stored unmount function
    const simulateUnmount = (atomInstance: Atom<any>) => { // Accept any Store type
        const instanceWithMocks = atomInstance as any;
        if (typeof instanceWithMocks.__mockUnmount === 'function') {
            instanceWithMocks.__mockUnmount();
            instanceWithMocks.__mockUnmount = undefined;
        }
    };


    beforeEach(async () => { // Make beforeEach async
        // Reset mocks for each test
        vi.clearAllMocks();

        // Create a fresh mock coordinator instance using the mocked constructor
        const { OptimisticSyncCoordinator: MockCoordinator } = await import('../coordinator');
        mockCoordinatorInstance = new MockCoordinator(); // Create instance
        // Clear listeners on the mock emitter if applicable
        (mockCoordinatorInstance as any).__mockClearListeners?.(); // Cast to any before accessing mock property

        // Cast to 'any' here to bypass strict type check for mockReturnValue
        vi.mocked(mockClient.getCoordinator).mockReturnValue(mockCoordinatorInstance as any);

        // Create a client atom instance
        clientAtom = atom<ZenQueryClient>(mockClient);

        // No need to mock map() directly if using actual map and mocking onMount
        // mockMapStore = map({ ... })

        // Override the map import specifically for this test suite context if needed,
        // or ensure the global mock is sufficient. The global mock might be tricky.
        // Let's rely on the actual map and mock onMount behavior.

        // Reset query procedure mock
        mockQueryProcedure.mockReset();

        // Reset registry mocks
        vi.mocked(generateAtomKey).mockClear();
        vi.mocked(registerAtom).mockClear();
        vi.mocked(unregisterAtom).mockClear();
        vi.mocked(getAtom).mockClear();

        // Reset patch util mocks
        vi.mocked(applyImmerPatches).mockClear();
        vi.mocked(applyJsonDelta).mockClear();

        // Reset nanostores mocks
        vi.mocked(map).mockClear(); // Clear calls to map if mocking it directly
        vi.mocked(onMount).mockClear();
        vi.mocked(task).mockClear();

        // Clear captured unmount from previous tests if necessary (handled by simulateUnmount now)
        capturedUnmount = undefined;
        // onMount mock is now handled globally via vi.mock('nanostores', ...)
    });

    afterEach(() => {
        // Simulate unmount for any atom that might have been mounted
        // This requires tracking mounted atoms or applying to a known one like queryAtom if defined
        // For simplicity, ensure tests call simulateUnmount explicitly if they call simulateMount.
    });

    const clientGetter = <T extends ZenQueryClient>(ca: Atom<T>) => ca.get();
    const defaultPath = 'posts.get';
    const defaultInput = { id: '123' };
    const defaultOptions: QueryOptions<typeof defaultInput, { id: string; title: string }> = {
        input: defaultInput,
        path: defaultPath,
    };
    const defaultAtomKey = JSON.stringify({ path: defaultPath, input: defaultInput });

    // --- Test Cases ---

    it('should initialize with correct default state (enabled: true)', () => {
        const queryAtom = query(clientAtom, clientGetter, defaultOptions);
        const initialState = queryAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.loading).toBe(true); // Starts loading immediately if enabled
        expect(initialState.error).toBeNull();
        expect(initialState.status).toBe('loading');
        expect(vi.mocked(generateAtomKey)).toHaveBeenCalledWith(defaultPath, defaultInput);
        expect(queryAtom.key).toBe(defaultAtomKey);
    });

    it('should initialize with correct default state (enabled: false)', () => {
        const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, enabled: false });
        const initialState = queryAtom.get();

        expect(initialState.data).toBeUndefined();
        expect(initialState.loading).toBe(false);
        expect(initialState.error).toBeNull();
        expect(initialState.status).toBe('idle');
    });

     it('should initialize with initialData', () => {
        const initialData = { id: '123', title: 'Initial Title' };
        const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
        const initialState = queryAtom.get();

        expect(initialState.data).toEqual(initialData);
        expect(initialState.loading).toBe(true); // Still loads if enabled
        expect(initialState.error).toBeNull();
        expect(initialState.status).toBe('loading'); // Status reflects loading, data is stale
    });

    describe('onMount', () => {
        it('should register the atom with the registry', () => {
            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
            simulateMount(queryAtom); // Simulate mount

            expect(vi.mocked(registerAtom)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(registerAtom)).toHaveBeenCalledWith(defaultAtomKey, queryAtom);
        });

        it('should subscribe to coordinator events (onStateChange, onApplyDelta)', () => {
            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
            simulateMount(queryAtom);

            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onStateChange', expect.any(Function));
            expect(vi.mocked(mockCoordinatorInstance.on)).toHaveBeenCalledWith('onApplyDelta', expect.any(Function));
            // Add checks for other events if query subscribes to them
        });

        it('should call fetcher immediately if enabled and no initialData', async () => {
            mockQueryProcedure.mockResolvedValue({ id: '123', title: 'Fetched Title' });
            const queryAtom = query(clientAtom, clientGetter, defaultOptions);

            // Check initial state before mount simulation completes async fetch
            expect(queryAtom.get().status).toBe('loading');
            expect(queryAtom.get().loading).toBe(true);

            simulateMount(queryAtom);

            // Wait for promises to resolve
            await vi.waitFor(() => {
                expect(mockQueryProcedure).toHaveBeenCalledTimes(1);
            });
            expect(mockQueryProcedure).toHaveBeenCalledWith(defaultInput, { signal: expect.any(AbortSignal) });

            // Check state after fetch
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
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });

            // Check initial state before mount
            expect(queryAtom.get().status).toBe('loading'); // Status is loading
            expect(queryAtom.get().loading).toBe(true);
            expect(queryAtom.get().data).toEqual(initialData); // Stale data is present

            simulateMount(queryAtom);

            await vi.waitFor(() => {
                expect(mockQueryProcedure).toHaveBeenCalledTimes(1);
            });
            expect(mockQueryProcedure).toHaveBeenCalledWith(defaultInput, { signal: expect.any(AbortSignal) });

            // Check state after fetch
            await vi.waitFor(() => {
                expect(queryAtom.get().status).toBe('success');
            });
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toEqual({ id: '123', title: 'Fetched Title' }); // Data updated
            expect(queryAtom.get().error).toBeNull();
        });

        it('should NOT call fetcher if enabled: false', () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, enabled: false });
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

            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
            simulateMount(queryAtom); // Mount
            simulateUnmount(queryAtom); // Unmount

            expect(vi.mocked(unregisterAtom)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(unregisterAtom)).toHaveBeenCalledWith(defaultAtomKey);
            expect(mockUnsubChange).toHaveBeenCalledTimes(1);
            expect(mockUnsubDelta).toHaveBeenCalledTimes(1);
        });

        it('should abort ongoing fetch on unmount', async () => {
            const abortController = new AbortController();
            const signal = abortController.signal;
            const abortSpy = vi.spyOn(abortController, 'abort');

            // Mock fetcher to return a promise that never resolves unless aborted
            const neverResolves = new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
            mockQueryProcedure.mockImplementation(({ signal: fetchSignal }) => {
                 // Link external controller's abort to the fetch signal
                 fetchSignal.addEventListener('abort', () => abortController.abort());
                 return neverResolves;
            });


            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
            simulateMount(queryAtom); // Start fetch

            expect(mockQueryProcedure).toHaveBeenCalledTimes(1);
            expect(queryAtom.get().loading).toBe(true);

            // Simulate unmount while fetch is "in progress"
            simulateUnmount(queryAtom);

            // Check if abort was called on the controller associated with the fetch
            // Need to inspect the internal state or mock AbortController globally?
            // Let's check the state change expected on abort
            await vi.waitFor(() => {
                 // The internal abort logic should reset loading state if aborted
                 // Note: The exact state depends on whether initialData was present. Here, none.
                 expect(queryAtom.get().loading).toBe(false);
                 expect(queryAtom.get().status).toBe('idle'); // Goes back to idle as fetch was aborted
            });

             // We can't directly check the internal abortController easily without exposing it.
             // Rely on the state change and the mock implementation's behavior on abort.
        });

    });

    describe('Fetching Logic', () => {
        it('should set data and success status on successful fetch', async () => {
            const fetchedData = { id: '123', title: 'Fetched OK' };
            mockQueryProcedure.mockResolvedValue(fetchedData);
            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
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
            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
            simulateMount(queryAtom);

            await vi.waitFor(() => {
                expect(queryAtom.get().status).toBe('error');
            });
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toBeUndefined(); // Data remains undefined on error
            expect(queryAtom.get().error).toBe(fetchError);
        });

        it('should handle fetch abortion correctly', async () => {
            let externalAbortController = new AbortController();
            const abortError = new DOMException('Aborted', 'AbortError');

            // Mock fetcher to reject when aborted
            mockQueryProcedure.mockImplementation(async ({ signal }) => {
                return new Promise((resolve, reject) => {
                    const onAbort = () => {
                        clearTimeout(timeoutId); // Clear timeout if aborted
                        reject(abortError);
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                    // Simulate a delay
                    const timeoutId = setTimeout(() => {
                        signal.removeEventListener('abort', onAbort);
                        resolve({ id: '123', title: 'Should not resolve' });
                    }, 50); // Short delay
                });
            });

            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
            simulateMount(queryAtom); // Starts the fetch

            expect(queryAtom.get().loading).toBe(true);
            expect(queryAtom.get().status).toBe('loading');

            // Abort the fetch *before* the timeout completes
            // Need to access the internal AbortController or trigger abort externally
            // Let's simulate unmount which should trigger abort
            simulateUnmount(queryAtom);

            // Wait for state to reflect abortion
            await vi.waitFor(() => {
                expect(queryAtom.get().loading).toBe(false);
            });
            // Status should revert based on initial state (idle if no initialData)
            expect(queryAtom.get().status).toBe('idle');
            expect(queryAtom.get().error).toBeNull(); // Abort is not treated as an error state
        });

        it('should ignore result from stale fetch if a new fetch was initiated', async () => {
            const firstFetchResult = { id: '123', title: 'First Result (Stale)' };
            const secondFetchResult = { id: '123', title: 'Second Result (Current)' };
            let firstFetchResolve: (value: any) => void;
            let secondFetchResolve: (value: any) => void;

            // First call setup
            mockQueryProcedure.mockImplementationOnce(async ({ signal }) => {
                return new Promise((resolve) => { firstFetchResolve = resolve; });
            });

            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
            simulateMount(queryAtom); // Initiates first fetch

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(1));
            expect(queryAtom.get().loading).toBe(true);

            // Trigger reload, initiating the second fetch
            mockQueryProcedure.mockImplementationOnce(async ({ signal }) => {
                return new Promise((resolve) => { secondFetchResolve = resolve; });
            });
            await queryAtom.reload(); // Should abort first, start second

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(2));
            expect(queryAtom.get().loading).toBe(true); // Still loading for the second fetch

            // Resolve the second fetch first
            secondFetchResolve!(secondFetchResult);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));
            expect(queryAtom.get().data).toEqual(secondFetchResult);

            // Now resolve the first (stale) fetch - it should be ignored
            firstFetchResolve!(firstFetchResult);
            // Wait a bit to ensure no state change happens
            await new Promise(res => setTimeout(res, 10));
            expect(queryAtom.get().data).toEqual(secondFetchResult); // Data should remain from the second fetch
            expect(queryAtom.get().status).toBe('success');
            expect(queryAtom.get().loading).toBe(false);
        });

         it('should ignore error from stale fetch if a new fetch was initiated', async () => {
            const secondFetchResult = { id: '123', title: 'Second Result (Current)' };
            const firstFetchError = new Error('First fetch failed (Stale)');
            let firstFetchReject: (reason?: any) => void;
            let secondFetchResolve: (value: any) => void;

            // First call setup (will reject)
            mockQueryProcedure.mockImplementationOnce(async ({ signal }) => {
                return new Promise((resolve, reject) => { firstFetchReject = reject; });
            });

            const queryAtom = query(clientAtom, clientGetter, defaultOptions);
            simulateMount(queryAtom); // Initiates first fetch

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(1));
            expect(queryAtom.get().loading).toBe(true);

            // Trigger reload, initiating the second fetch (will resolve)
            mockQueryProcedure.mockImplementationOnce(async ({ signal }) => {
                return new Promise((resolve) => { secondFetchResolve = resolve; });
            });
            await queryAtom.reload(); // Should abort first, start second

            await vi.waitFor(() => expect(mockQueryProcedure).toHaveBeenCalledTimes(2));
            expect(queryAtom.get().loading).toBe(true); // Still loading for the second fetch

            // Resolve the second fetch first
            secondFetchResolve!(secondFetchResult);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));
            expect(queryAtom.get().data).toEqual(secondFetchResult);
            expect(queryAtom.get().error).toBeNull();

            // Now reject the first (stale) fetch - the error should be ignored
            firstFetchReject!(firstFetchError);
            // Wait a bit to ensure no state change happens
            await new Promise(res => setTimeout(res, 10));
            expect(queryAtom.get().data).toEqual(secondFetchResult); // Data should remain
            expect(queryAtom.get().status).toBe('success'); // Status should remain success
            expect(queryAtom.get().error).toBeNull(); // Error should remain null
            expect(queryAtom.get().loading).toBe(false);
        });

    });

    describe('Optimistic Updates (onStateChange)', () => {
        const initialData = { id: '123', title: 'Initial' };
        // Correct Immer patch path format: use array ['title'] instead of string '/title'
        const optimisticPatch: Patch[] = [{ op: 'replace', path: ['title'], value: 'Optimistic Update' }];
        const expectedOptimisticData = { id: '123', title: 'Optimistic Update', __appliedOptimistic: true }; // Based on mock

        beforeEach(() => {
            // Ensure fetch resolves successfully with initial data for these tests
            mockQueryProcedure.mockResolvedValue(initialData);
        });

        it('should apply pending patches from coordinator on onStateChange', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            // Setup coordinator mock to return patches by setting the mock fn's implementation
            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            // Directly control the mock function defined in the factory, cast return to any
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            // Trigger state change
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            // Verify applyImmerPatches was called
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            // Check base state (should be the confirmed server data after initial fetch)
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(initialData, optimisticPatch);

            // Verify atom state updated optimistically
            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
            expect(queryAtom.get().status).toBe('success'); // Status remains success
        });

        it('should use confirmedServerData as base for optimistic updates', async () => {
            const queryAtom = query(clientAtom, clientGetter, defaultOptions); // No initial data
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for fetch

            // Setup coordinator mock
            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            // Trigger state change
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            // Base state should be the data fetched initially
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(initialData, optimisticPatch);
            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
        });

        it('should do nothing if no pending patches for this atom', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            // Coordinator returns empty map
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => new Map() as any);
            vi.mocked(applyImmerPatches).mockClear(); // Clear previous calls if any

            // Trigger state change
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).not.toHaveBeenCalled();
            expect(queryAtom.get().data).toEqual(initialData); // Data remains unchanged
        });

        it('should handle errors during optimistic patch application', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const patchError = new Error('Patch application failed');
            vi.mocked(applyImmerPatches).mockImplementation(() => { throw patchError; });

            // Setup coordinator mock
            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            // Trigger state change
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');

            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            expect(queryAtom.get().status).toBe('error'); // Status should change to error
            expect(queryAtom.get().error).toBe(patchError);
            expect(queryAtom.get().data).toEqual(initialData); // Data should fallback to confirmed state
        });

         it('should clear computation error if subsequent computation succeeds', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const patchError = new Error('Patch application failed');
            const pendingPatchesMap = new Map<AtomKey, Patch[]>();
            pendingPatchesMap.set(defaultAtomKey, optimisticPatch);
            vi.mocked(mockCoordinatorInstance.getPendingPatches).mockImplementation(() => pendingPatchesMap as any);

            // First computation fails
            vi.mocked(applyImmerPatches).mockImplementationOnce(() => { throw patchError; });
            (mockCoordinatorInstance as any).__mockEmit('onStateChange');
            expect(queryAtom.get().status).toBe('error');
            expect(queryAtom.get().error).toBe(patchError);

            // Second computation succeeds
            vi.mocked(applyImmerPatches).mockImplementationOnce(() => expectedOptimisticData); // Mock success
            (mockCoordinatorInstance as any).__mockEmit('onStateChange'); // Trigger again

            expect(queryAtom.get().status).toBe('success'); // Status should recover (assuming no fetch error)
            expect(queryAtom.get().error).toBeNull(); // Error should be cleared
            expect(queryAtom.get().data).toEqual(expectedOptimisticData);
        });
    });

    describe('Server Deltas (onApplyDelta)', () => {
        const initialData = { id: '123', title: 'Initial', version: 1 };
        // Use fast-json-patch Operation type for server deltas
        const serverDeltaPatch: PatchOperation[] = [{ op: 'replace', path: '/title', value: 'Server Update' }, { op: 'replace', path: '/version', value: 2 }];
        const expectedDeltaAppliedData = { ...initialData, title: 'Server Update', version: 2, __appliedDelta: true }; // Based on mock applyJsonDelta
        const expectedOptimisticAfterDelta = { ...expectedDeltaAppliedData, __appliedOptimistic: true }; // Based on mock applyImmerPatches

        beforeEach(() => {
            // Ensure fetch resolves successfully with initial data
            mockQueryProcedure.mockResolvedValue(initialData);
        });

        it('should apply server delta patches to confirmed state and recompute optimistic state', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            vi.mocked(applyJsonDelta).mockClear();
            vi.mocked(applyImmerPatches).mockClear(); // Also check optimistic recomputation

            // Simulate receiving a delta for this atom
            const serverDelta: ServerDelta = {
                serverSeq: 1, // Example sequence
                key: defaultAtomKey,
                patches: serverDeltaPatch,
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            // Verify applyJsonDelta was called correctly
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledTimes(1);
            // Base should be the confirmed server data (initialData after fetch)
            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledWith(initialData, serverDeltaPatch);

            // Verify optimistic state was recomputed (applyImmerPatches called by computeOptimisticState)
            // It should be called with the *new* confirmed state (result of applyJsonDelta mock)
            // and potentially empty patches if no pending mutations exist.
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledTimes(1);
            // The base for optimistic computation is the result of applyJsonDelta
            expect(vi.mocked(applyImmerPatches)).toHaveBeenCalledWith(expectedDeltaAppliedData, []); // Assuming no pending patches

            // Verify atom state reflects the delta application (via optimistic computation)
            expect(queryAtom.get().data).toEqual(expectedOptimisticAfterDelta); // Mock applyImmerPatches returns this
            expect(queryAtom.get().status).toBe('success');
        });

        it('should ignore deltas for different atom keys', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            vi.mocked(applyJsonDelta).mockClear();

            // Simulate receiving a delta for a different atom
            const differentKey = 'different/atom';
            const serverDelta: ServerDelta = {
                serverSeq: 1,
                key: differentKey,
                patches: serverDeltaPatch,
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            // Verify applyJsonDelta was NOT called
            expect(vi.mocked(applyJsonDelta)).not.toHaveBeenCalled();
            expect(queryAtom.get().data).toEqual(initialData); // State remains unchanged
        });

        it('should handle errors during delta application', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            const deltaError = new Error('Delta application failed');
            vi.mocked(applyJsonDelta).mockImplementation(() => { throw deltaError; });

            // Simulate receiving a delta
            const serverDelta: ServerDelta = {
                serverSeq: 1,
                key: defaultAtomKey,
                patches: serverDeltaPatch,
            };
            (mockCoordinatorInstance as any).__mockEmit('onApplyDelta', serverDelta);

            expect(vi.mocked(applyJsonDelta)).toHaveBeenCalledTimes(1);
            expect(queryAtom.get().status).toBe('error'); // Status should change to error
            expect(queryAtom.get().error).toBe(deltaError);
            // Data might remain the old confirmed state or become undefined depending on error handling details
            // The current implementation falls back to confirmed state before error
            expect(queryAtom.get().data).toEqual(initialData);
        });
    });

    describe('reload() function', () => {
        const initialData = { id: '123', title: 'Initial' };
        const reloadData = { id: '123', title: 'Reloaded Data' };

        beforeEach(() => {
            // Initial fetch resolves with initialData
            mockQueryProcedure.mockResolvedValueOnce(initialData);
        });

        it('should set loading state and re-fetch data when called', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success')); // Wait for initial fetch

            // Setup mock for the reload fetch
            mockQueryProcedure.mockResolvedValueOnce(reloadData);

            // Call reload
            const reloadPromise = queryAtom.reload();

            // Check state immediately after calling reload (should be loading)
            expect(queryAtom.get().loading).toBe(true);
            expect(queryAtom.get().status).toBe('loading');
            expect(queryAtom.get().error).toBeNull(); // Error should be cleared on reload start
            expect(queryAtom.get().data).toEqual(initialData); // Stale data remains initially

            await reloadPromise; // Wait for reload fetch to complete

            // Check state after reload completes
            expect(mockQueryProcedure).toHaveBeenCalledTimes(2); // Initial fetch + reload
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().status).toBe('success');
            expect(queryAtom.get().data).toEqual(reloadData);
            expect(queryAtom.get().error).toBeNull();
        });

        it('should handle errors during reload fetch', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            // Setup mock for the reload fetch to fail
            const reloadError = new Error('Reload Failed');
            mockQueryProcedure.mockRejectedValueOnce(reloadError);

            // Call reload and expect it to reject
            await expect(queryAtom.reload()).rejects.toThrow('Reload Failed');

            // Check state after failed reload
            expect(mockQueryProcedure).toHaveBeenCalledTimes(2);
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().status).toBe('error');
            expect(queryAtom.get().error).toBe(reloadError);
            expect(queryAtom.get().data).toEqual(initialData); // Data should remain the last successful state
        });

        it('should not fetch if query is disabled', async () => {
             const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData, enabled: false });
             simulateMount(queryAtom);
             expect(queryAtom.get().status).toBe('idle'); // Starts idle

             mockQueryProcedure.mockClear(); // Clear any potential calls

             await queryAtom.reload(); // Attempt reload

             expect(mockQueryProcedure).not.toHaveBeenCalled();
             expect(queryAtom.get().status).toBe('idle'); // Remains idle
             expect(queryAtom.get().loading).toBe(false);
        });

         it('should not fetch if component is unmounted', async () => {
            const queryAtom = query(clientAtom, clientGetter, { ...defaultOptions, initialData });
            simulateMount(queryAtom);
            await vi.waitFor(() => expect(queryAtom.get().status).toBe('success'));

            simulateUnmount(queryAtom); // Unmount

            mockQueryProcedure.mockClear(); // Clear initial fetch call count

            await queryAtom.reload(); // Attempt reload

            expect(mockQueryProcedure).not.toHaveBeenCalled();
            // State should remain as it was before unmount
            expect(queryAtom.get().status).toBe('success');
            expect(queryAtom.get().loading).toBe(false);
            expect(queryAtom.get().data).toEqual(initialData);
        });
    });

    // TODO: Add describe blocks for:
    // - Error Handling (final checks)

});