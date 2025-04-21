import { describe, it, expect } from 'vitest';
import { map, atom, type WritableAtom } from 'nanostores';

import { hybrid, type HybridAtomState, type HybridStatus } from './hybrid';
import type { QueryMapState, QueryAtom } from './query';
import type { SubscriptionAtomState, SubscriptionStatus, SubscriptionAtom } from './subscription';

// Define a type for the mock atoms that includes writability and required properties
type MockWritableQueryAtom<TData = any, TError = Error> = WritableAtom<QueryMapState<TData, TError>> & {
    key: string;
    reload: () => Promise<void>;
};
type MockWritableSubscriptionAtom<TData = any, TError = Error> = WritableAtom<SubscriptionAtomState<TData, TError>> & {
    key: string;
};

// Helper to create a mock QueryAtom using a map, satisfying the interface
const createMockQueryAtom = <TData extends object | unknown[] = any, TError = Error>(
    initialState: QueryMapState<TData, TError>
): MockWritableQueryAtom<TData, TError> => {
    const baseAtom = map<QueryMapState<TData, TError>>(initialState);
    // Return an object that spreads the base atom and adds the required properties
    return {
        ...baseAtom, // Spread properties/methods of the map store
        key: 'mockQueryKey',
        reload: async () => {},
        // Ensure it satisfies WritableAtom by including set/setKey if not spread
        set: baseAtom.set,
        setKey: baseAtom.setKey,
    } as MockWritableQueryAtom<TData, TError>; // Cast is safer now structure matches
};

// Helper to create a mock SubscriptionAtom using a map, satisfying the interface
const createMockSubscriptionAtom = <TData extends object | unknown[] = any, TError = Error>(
    initialState: SubscriptionAtomState<TData, TError>
): MockWritableSubscriptionAtom<TData, TError> => {
    const baseAtom = map<SubscriptionAtomState<TData, TError>>(initialState);
    // Return an object that spreads the base atom and adds the required properties
    return {
        ...baseAtom, // Spread properties/methods of the map store
        key: 'mockSubKey',
        // Ensure it satisfies WritableAtom by including set/setKey if not spread
        set: baseAtom.set,
        setKey: baseAtom.setKey,
    } as MockWritableSubscriptionAtom<TData, TError>; // Cast is safer now structure matches
};


describe('hybrid Nanostores helper', () => {
    // Use object data type for tests to satisfy TData constraint
    type TestData = { value: string };
    const queryData: TestData = { value: 'queryData' };
    const subData: TestData = { value: 'subData' };

    it('should initialize correctly with idle states', () => {
        const queryAtom = createMockQueryAtom<TestData>({ data: undefined, loading: false, error: null, status: 'idle' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: undefined, status: 'idle', error: null });
        const hybridAtom = hybrid(queryAtom, subAtom);

        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: undefined,
            loading: false,
            error: null,
            status: 'idle',
        });
    });

    it('should reflect query loading state', () => {
        const queryAtom = createMockQueryAtom<TestData>({ data: undefined, loading: true, error: null, status: 'loading' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: undefined, status: 'idle', error: null });
        const hybridAtom = hybrid(queryAtom, subAtom);

        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: undefined,
            loading: true,
            error: null,
            status: 'loading',
        });
    });

    it('should reflect subscription connecting state', () => {
        const queryAtom = createMockQueryAtom<TestData>({ data: queryData, loading: false, error: null, status: 'success' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: undefined, status: 'connecting', error: null });
        const hybridAtom = hybrid(queryAtom, subAtom);

        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: queryData, // Still uses query data while connecting
            loading: true,     // Loading is true when connecting
            error: null,
            status: 'connecting',
        });
    });

    it('should prioritize subscription data when connected', () => {
        const queryAtom = createMockQueryAtom<TestData>({ data: queryData, loading: false, error: null, status: 'success' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: subData, status: 'connected', error: null });
        const hybridAtom = hybrid(queryAtom, subAtom);

        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: subData, // Uses subscription data
            loading: false,
            error: null,
            status: 'active', // Status becomes active
        });
    });

     it('should use query data if subscription is connected but has no data yet', () => {
        const queryAtom = createMockQueryAtom<TestData>({ data: queryData, loading: false, error: null, status: 'success' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: undefined, status: 'connected', error: null }); // Sub connected, data undefined
        const hybridAtom = hybrid(queryAtom, subAtom);

        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: queryData, // Falls back to query data
            loading: false,
            error: null,
            status: 'active',
        });
    });

    it('should prioritize subscription error', () => {
        const queryError = new Error('Query Failed');
        const subError = new Error('Subscription Failed');
        const queryAtom = createMockQueryAtom<TestData>({ data: queryData, loading: false, error: queryError, status: 'error' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: undefined, status: 'error', error: subError });
        const hybridAtom = hybrid(queryAtom, subAtom);

        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: queryData, // Data might still be query data if sub never provided any
            loading: false,    // Not loading if both errored
            error: subError,   // Prioritizes subscription error
            status: 'error',
        });
    });

    it('should use query error if subscription has no error', () => {
        const queryError = new Error('Query Failed');
        const queryAtom = createMockQueryAtom<TestData>({ data: undefined, loading: false, error: queryError, status: 'error' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: undefined, status: 'idle', error: null });
        const hybridAtom = hybrid(queryAtom, subAtom);

        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: undefined,
            loading: false,
            error: queryError, // Uses query error
            status: 'error',
        });
    });

    it('should handle subscription closing', () => {
        const queryAtom = createMockQueryAtom<TestData>({ data: queryData, loading: false, error: null, status: 'success' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: subData, status: 'closed', error: null });
        const hybridAtom = hybrid(queryAtom, subAtom);

        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: queryData, // Falls back to query data
            loading: false,
            error: null,
            status: 'active', // Status reflects query success
        });
    });

     it('should update status correctly when query finishes loading while sub is connecting', () => {
        const queryAtom = createMockQueryAtom<TestData>({ data: undefined, loading: true, error: null, status: 'loading' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: undefined, status: 'connecting', error: null });
        const hybridAtom = hybrid(queryAtom, subAtom);

        // Initial state
        expect(hybridAtom.get().status).toBe('connecting');
        expect(hybridAtom.get().loading).toBe(true);

        // Query finishes loading
        queryAtom.set({ data: queryData, loading: false, error: null, status: 'success' });

        // Hybrid state should still show connecting
        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: queryData,
            loading: true, // Still loading because sub is connecting
            error: null,
            status: 'connecting',
        });
    });

     it('should update status correctly when subscription connects after query loaded', () => {
        const queryAtom = createMockQueryAtom<TestData>({ data: queryData, loading: false, error: null, status: 'success' });
        const subAtom = createMockSubscriptionAtom<TestData>({ data: undefined, status: 'connecting', error: null });
        const hybridAtom = hybrid(queryAtom, subAtom);

        // Initial state (query loaded, sub connecting)
        expect(hybridAtom.get().status).toBe('connecting');
        expect(hybridAtom.get().loading).toBe(true);
        expect(hybridAtom.get().data).toBe(queryData);

        // Subscription connects and provides data
        subAtom.set({ data: subData, status: 'connected', error: null });

        // Hybrid state should reflect subscription dominance
        expect(hybridAtom.get()).toEqual<HybridAtomState<TestData>>({
            data: subData,
            loading: false,
            error: null,
            status: 'active',
        });
    });

});