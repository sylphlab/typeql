/** @jsxImportSource react */ // Add JSX pragma
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react'; // Use React Testing Library
import React, { ReactNode } from 'react'; // Ensure React is imported for JSX
import { zenQueryProvider } from '../context.tsx'; // Correct import path
import { useQuery } from '../hooks/useQuery'; // Import React hook
import type { createClient, OptimisticSyncCoordinator } from '@sylphlab/zen-query-client'; // Import createClient AND Coordinator type
import type { zenQueryClientError } from '@sylphlab/zen-query-shared'; // Import error type from shared
// Import Operation type if needed for coordinator mock
import type { Operation as PatchOperation } from 'fast-json-patch';
import type { AtomKey } from '@sylphlab/zen-query-client/utils/atomRegistry'; // Assuming this path is correct or adjust as needed

// Use ReturnType to get the actual client type
type zenQueryClientInstance = ReturnType<typeof createClient>;

// Mock client
const mockQueryProcedure = vi.fn(); // Renamed for clarity
const mockMutateProcedure = vi.fn();
const mockSubscribeProcedure = vi.fn();

// More complete mock for Coordinator, matching the PUBLIC interface structure from coordinator.ts
const mockCoordinator: OptimisticSyncCoordinator = {
    // Mock public methods from the interface
    on: vi.fn(() => vi.fn()), // Mock the public 'on' method directly, assuming it returns unsubscribe
    getPendingPatches: vi.fn(() => new Map<AtomKey, PatchOperation[]>()), // Use AtomKey if defined correctly
    generateClientSeq: vi.fn(() => Date.now()),
    registerPendingMutation: vi.fn(),
    confirmMutation: vi.fn(),
    rejectMutation: vi.fn(),
    processServerDelta: vi.fn(),
    getConfirmedServerSeq: vi.fn(() => 0),
    hasPendingMutations: vi.fn(() => false),
    // Add any other public methods if they exist in the actual interface
};
// mockGetCoordinator should return the mock coordinator instance
const mockGetCoordinator = vi.fn<[], OptimisticSyncCoordinator>(() => mockCoordinator); // Explicitly type return

const mockClient: zenQueryClientInstance = {
  // Structure the mock to match expected proxy output
  query: {
      test: {
          get: { // Assuming path 'test.get' is used in tests
              _isZenQueryProcedure: true,
              path: 'test.get',
              procedure: { query: mockQueryProcedure }
          }
      }
  } as any, // Use 'as any' for simplicity, refine if needed
  mutation: { // Mock mutation structure based on client.ts proxy
      // Add specific procedures if needed by tests, e.g., posts: { create: { mutate: mockMutateProcedure } }
  } as any,
  subscription: { // Mock subscription structure
      // Add specific procedures if needed
  } as any,
  getCoordinator: mockGetCoordinator,
  close: vi.fn(),
  // Add any other properties expected by the client type if necessary
  transport: {} as any,
  storeInterface: {} as any,
};

// Wrapper component providing the context (using React JSX)
// Define it explicitly for clarity, though renderHook's wrapper option should work
const createWrapper = (client: zenQueryClientInstance) => ({ children }: { children: ReactNode }) => (
  <zenQueryProvider client={client}>{children}</zenQueryProvider>
);

describe('useQuery (React)', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockQueryProcedure.mockClear(); // Use renamed mock
    mockGetCoordinator.mockClear();
    vi.mocked(mockCoordinator.on).mockClear(); // Clear the 'on' mock
    vi.mocked(mockCoordinator.getPendingPatches).mockClear();
    // Clear other coordinator mocks if necessary
    vi.mocked(mockCoordinator.generateClientSeq).mockClear();
    vi.mocked(mockCoordinator.registerPendingMutation).mockClear();
    vi.mocked(mockCoordinator.confirmMutation).mockClear();
    vi.mocked(mockCoordinator.rejectMutation).mockClear();
    vi.mocked(mockCoordinator.processServerDelta).mockClear();
    vi.mocked(mockCoordinator.getConfirmedServerSeq).mockClear();
    vi.mocked(mockCoordinator.hasPendingMutations).mockClear();
  });

  it('should initialize with fetching state and undefined data/error', () => {
    mockQueryProcedure.mockReturnValue(new Promise(() => {})); // Mock a pending promise

    const wrapper = createWrapper(mockClient); // Create wrapper instance
    // Pass the actual mock procedure function and input correctly
    const { result } = renderHook(() => useQuery(mockQueryProcedure, { id: '1' }), { wrapper });

    // Access state directly (no .value)
    expect(result.current.isFetching).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
    // Check if mockQueryProcedure was called with the input
    expect(mockQueryProcedure).toHaveBeenCalledOnce();
    expect(mockQueryProcedure).toHaveBeenCalledWith({ id: '1' });
  });

  it('should not fetch if enabled is false', () => {
     mockQueryProcedure.mockReturnValue(new Promise(() => {}));
     const wrapper = createWrapper(mockClient);
     // Pass input as second arg, options as third
     const { result } = renderHook(() => useQuery(mockQueryProcedure, { id: '1' }, { enabled: false }), { wrapper });

     expect(result.current.isFetching).toBe(false);
     expect(result.current.data).toBeUndefined();
     expect(result.current.error).toBeNull();
     expect(mockQueryProcedure).not.toHaveBeenCalled();
  });

  it('should update data on successful fetch', async () => {
    const responseData = { message: 'Success!' };
    mockQueryProcedure.mockResolvedValue(responseData);

    const wrapper = createWrapper(mockClient);
    // Pass the actual mock procedure function and input correctly
    const { result } = renderHook(() => useQuery(mockQueryProcedure, { id: '2' }), { wrapper });

    expect(result.current.isFetching).toBe(true);

    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });

    expect(result.current.data).toEqual(responseData);
    expect(result.current.error).toBeNull();
    // Check if mockQueryProcedure was called with the input
    expect(mockQueryProcedure).toHaveBeenCalledOnce();
    expect(mockQueryProcedure).toHaveBeenCalledWith({ id: '2' });
  });

  it('should update error on failed fetch', async () => {
    const errorResponse: zenQueryClientError = new Error('Query Failed');
    mockQueryProcedure.mockRejectedValue(errorResponse);

    const wrapper = createWrapper(mockClient);
    // Pass the actual mock procedure function and input correctly
    const { result } = renderHook(() => useQuery(mockQueryProcedure, { id: '3' }), { wrapper });

    expect(result.current.isFetching).toBe(true);

    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });

    expect(result.current.error).toEqual(errorResponse);
    expect(result.current.data).toBeUndefined();
    // Check if mockQueryProcedure was called with the input
    expect(mockQueryProcedure).toHaveBeenCalledOnce();
    expect(mockQueryProcedure).toHaveBeenCalledWith({ id: '3' });
  });

  it('should refetch when input changes', async () => {
    const responseData1 = { id: '4', data: 'First' };
    const responseData2 = { id: '5', data: 'Second' };
    mockQueryProcedure
      .mockResolvedValueOnce(responseData1)
      .mockResolvedValueOnce(responseData2);

    // Use simple variable for input props
    let currentInput = { id: '4' };

    const wrapper = createWrapper(mockClient);
    const { result, rerender } = renderHook(
        // Pass input as second arg
        (props) => useQuery(mockQueryProcedure, props.input), // Pass actual mock procedure
        {
            wrapper,
            initialProps: { input: currentInput }
        }
    );

    // Initial fetch
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.data).toEqual(responseData1);
    expect(mockQueryProcedure).toHaveBeenCalledTimes(1);
    expect(mockQueryProcedure).toHaveBeenCalledWith({ id: '4' }); // Check input directly

    // Change input prop
    currentInput = { id: '5' };
    // Rerender the hook with new props
    rerender({ input: currentInput });


    // Expect fetching state to become true again briefly
    // Need waitFor as the effect runs asynchronously after rerender
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    // Wait for second fetch to complete
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(result.current.data).toEqual(responseData2);
    expect(result.current.error).toBeNull();
    expect(mockQueryProcedure).toHaveBeenCalledTimes(2);
    expect(mockQueryProcedure).toHaveBeenCalledWith({ id: '5' }); // Check input directly
  });

   it('should start fetching when enabled becomes true', async () => {
       const responseData = { message: 'Fetched!' };
       mockQueryProcedure.mockResolvedValue(responseData);
       let currentEnabled = false; // Start disabled

       const wrapper = createWrapper(mockClient);
       const { result, rerender } = renderHook(
           // Pass input as second arg, options as third
           (props) => useQuery(mockQueryProcedure, { id: '6' }, { enabled: props.enabled }), // Pass actual mock procedure
           {
               wrapper,
               initialProps: { enabled: currentEnabled }
           }
       );

       expect(result.current.isFetching).toBe(false);
       expect(mockQueryProcedure).not.toHaveBeenCalled();

       // Enable the query
       currentEnabled = true;
       rerender({ enabled: currentEnabled });

       // Expect fetching state to become true
       await waitFor(() => expect(result.current.isFetching).toBe(true));
       // Wait for fetch to complete
       await waitFor(() => expect(result.current.isFetching).toBe(false));

       expect(result.current.data).toEqual(responseData);
       expect(mockQueryProcedure).toHaveBeenCalledOnce();
       expect(mockQueryProcedure).toHaveBeenCalledWith({ id: '6' }); // Check input directly
   });

});