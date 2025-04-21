import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'; // Import Mock
import { renderHook, waitFor, act } from '@testing-library/preact';
import { h } from 'preact';
import { signal } from '@preact/signals-core';
import { zenQueryProvider } from '../context';
import { useQuery } from './useQuery';
// Import types correctly
import type { ZenQueryClient, OptimisticSyncCoordinator } from '@sylphlab/zen-query-client'; // Corrected case and added OptimisticSyncCoordinator
import type { zenQueryClientError } from '@sylphlab/zen-query-shared';

// Mock client (complete structure)
const mockQuery = vi.fn();
const mockMutation = vi.fn();
const mockSubscription = vi.fn();

// Mock the emitter structure separately for clarity
const mockEmitter = {
    on: vi.fn(),
    emit: vi.fn(),
};

// Refined mock coordinator structure
const mockGetCoordinator = vi.fn(() => ({
    // Public methods
    on: mockEmitter.on, // Public 'on' delegates to emitter
    generateClientSeq: vi.fn(() => Date.now()),
    registerPendingMutation: vi.fn(),
    confirmMutation: vi.fn(),
    rejectMutation: vi.fn(),
    processServerDelta: vi.fn(),
    getPendingPatches: vi.fn(() => new Map()),
    getConfirmedServerSeq: vi.fn(() => 0),
    hasPendingMutations: vi.fn(() => false),
    // Required properties for type compatibility
    emitter: mockEmitter, // The actual emitter instance
    // Mock internal properties needed to satisfy the type cast
    confirmedServerSeq: 0,
    clientSeqCounter: 0,
    pendingMutations: [],
} as unknown as OptimisticSyncCoordinator)); // Cast remains necessary for simplified mock

// Define type for the query part of the mock
type MockQueryProcedures = {
    [key: string]: Mock; // Use simple Mock type
};

const mockClient: ZenQueryClient = { // Corrected case
  query: { // Use flattened path as key
      'test.get': mockQuery
  } as MockQueryProcedures, // Explicitly type the query mock
  mutation: { } as any,
  subscription: { } as any,
  getCoordinator: mockGetCoordinator,
  close: vi.fn(),
};


// Wrapper component providing the context
const wrapper = ({ children }: { children: any }) =>
  h(zenQueryProvider, { client: mockClient, children }); // Pass children in props

describe('useQuery', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockQuery.mockClear();
    // Clear coordinator mocks
    vi.mocked(mockGetCoordinator().emitter.on).mockClear(); // Clear emitter's on
    vi.mocked(mockGetCoordinator().on).mockClear(); // Clear public on
  });

  it('should initialize with fetching state and undefined data/error', () => {
    mockQuery.mockReturnValue(new Promise(() => {})); // Mock a pending promise

    // Access the mock procedure using bracket notation and non-null assertion
    const mockProcedure = (input: { id: string }) => mockClient.query['test.get']!(input);
    const { result } = renderHook(() => useQuery(mockProcedure, { id: '1' }), { wrapper });

    expect(result.current.isFetching.value).toBe(true);
    expect(result.current.data.value).toBeUndefined();
    expect(result.current.error.value).toBeNull();
    expect(mockQuery).toHaveBeenCalledOnce(); // Called immediately by default
    // Check the arguments passed to the actual mock function
    expect(mockQuery).toHaveBeenCalledWith({ id: '1' });
  });

  it('should not fetch if enabled is false', () => {
     mockQuery.mockReturnValue(new Promise(() => {}));
     // Access the mock procedure using bracket notation and non-null assertion
     const mockProcedure = (input: { id: string }) => mockClient.query['test.get']!(input);
     const { result } = renderHook(() => useQuery(mockProcedure, { id: '1'}, { enabled: false }), { wrapper });

     expect(result.current.isFetching.value).toBe(false);
     expect(result.current.data.value).toBeUndefined();
     expect(result.current.error.value).toBeNull();
     expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should update data signal on successful fetch', async () => {
    const responseData = { message: 'Success!' };
    mockQuery.mockResolvedValue(responseData); // Mock successful resolution

    // Access the mock procedure using bracket notation and non-null assertion
    const mockProcedure = (input: { id: string }) => mockClient.query['test.get']!(input);
    const { result } = renderHook(() => useQuery(mockProcedure, { id: '2' }), { wrapper });

    // Initially fetching
    expect(result.current.isFetching.value).toBe(true);

    // Wait for the fetching to complete and data to update
    await waitFor(() => {
      expect(result.current.isFetching.value).toBe(false);
    });

    expect(result.current.data.value).toEqual(responseData);
    expect(result.current.error.value).toBeNull();
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledWith({ id: '2' });
  });

  it('should update error signal on failed fetch', async () => {
    const errorResponse: zenQueryClientError = new Error('Query Failed');
    mockQuery.mockRejectedValue(errorResponse); // Mock rejection

    // Access the mock procedure using bracket notation and non-null assertion
    const mockProcedure = (input: { id: string }) => mockClient.query['test.get']!(input);
    const { result } = renderHook(() => useQuery(mockProcedure, { id: '3' }), { wrapper });

    // Initially fetching
    expect(result.current.isFetching.value).toBe(true);

    // Wait for the fetching to complete and error to update
    await waitFor(() => {
      expect(result.current.isFetching.value).toBe(false);
    });

    expect(result.current.error.value).toEqual(errorResponse);
    expect(result.current.data.value).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledWith({ id: '3' });
  });

  it('should refetch when input changes', async () => {
    const responseData1 = { id: '4', data: 'First' };
    const responseData2 = { id: '5', data: 'Second' };
    mockQuery
      .mockResolvedValueOnce(responseData1)
      .mockResolvedValueOnce(responseData2);

    const inputSignal = signal({ id: '4' }); // Use a signal for input

    // Access the mock procedure using bracket notation and non-null assertion
    const mockProcedure = (input: { id: string }) => mockClient.query['test.get']!(input);
    const { result, rerender } = renderHook(
        // Pass the signal's value to the hook
        (props) => useQuery(mockProcedure, props.input),
        {
            wrapper,
            initialProps: { input: inputSignal.value }
        }
    );

    // Initial fetch
    await waitFor(() => expect(result.current.isFetching.value).toBe(false));
    expect(result.current.data.value).toEqual(responseData1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith({ id: '4' });

    // Change input signal value
    act(() => {
        inputSignal.value = { id: '5' };
    });
    // Rerender the hook with new props (containing the updated signal value)
    rerender({ input: inputSignal.value });


    // Expect fetching state to become true again briefly
    await waitFor(() => expect(result.current.isFetching.value).toBe(true));
    // Wait for second fetch to complete
    await waitFor(() => expect(result.current.isFetching.value).toBe(false));

    expect(result.current.data.value).toEqual(responseData2);
    expect(result.current.error.value).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledWith({ id: '5' });
  });

   it('should start fetching when enabled becomes true', async () => {
       const responseData = { message: 'Fetched!' };
       mockQuery.mockResolvedValue(responseData);
       const enabledSignal = signal(false); // Start disabled

       // Access the mock procedure using bracket notation and non-null assertion
       const mockProcedure = (input: { id: string }) => mockClient.query['test.get']!(input);
       const { result, rerender } = renderHook(
           (props) => useQuery(mockProcedure, { id: '6' }, { enabled: props.enabled }),
           {
               wrapper,
               initialProps: { enabled: enabledSignal.value }
           }
       );

       expect(result.current.isFetching.value).toBe(false);
       expect(mockQuery).not.toHaveBeenCalled();

       // Enable the query
       act(() => {
           enabledSignal.value = true;
       });
       rerender({ enabled: enabledSignal.value });

       // Expect fetching state to become true
       await waitFor(() => expect(result.current.isFetching.value).toBe(true));
       // Wait for fetch to complete
       await waitFor(() => expect(result.current.isFetching.value).toBe(false));

       expect(result.current.data.value).toEqual(responseData);
       expect(mockQuery).toHaveBeenCalledOnce();
       expect(mockQuery).toHaveBeenCalledWith({ id: '6' });
   });

});
