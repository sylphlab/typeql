import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/preact';
import { h } from 'preact';
import { signal } from '@preact/signals-core';
import { TypeQLProvider } from '../context';
import { useQuery } from './useQuery';
import type { TypeQLClient, TypeQLClientError } from '@sylphlab/typeql-client';

// Mock client
const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
  // Add other methods if needed by other hooks being tested indirectly
} as unknown as TypeQLClient<any>;

// Wrapper component providing the context
const wrapper = ({ children }: { children: any }) =>
  h(TypeQLProvider, { client: mockClient }, children);

describe('useQuery', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockQuery.mockClear();
  });

  it('should initialize with fetching state and undefined data/error', () => {
    mockQuery.mockReturnValue(new Promise(() => {})); // Mock a pending promise

    const mockProcedure = (input: { id: string }) => mockClient.query({ path: 'test.get', input });
    const { result } = renderHook(() => useQuery(mockProcedure, { id: '1' }), { wrapper });

    expect(result.current.isFetching.value).toBe(true);
    expect(result.current.data.value).toBeUndefined();
    expect(result.current.error.value).toBeNull();
    expect(mockQuery).toHaveBeenCalledOnce(); // Called immediately by default
  });

  it('should not fetch if enabled is false', () => {
     mockQuery.mockReturnValue(new Promise(() => {}));
     const mockProcedure = (input: { id: string }) => mockClient.query({ path: 'test.get', input });
     const { result } = renderHook(() => useQuery(mockProcedure, { id: '1'}, { enabled: false }), { wrapper });

     expect(result.current.isFetching.value).toBe(false);
     expect(result.current.data.value).toBeUndefined();
     expect(result.current.error.value).toBeNull();
     expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should update data signal on successful fetch', async () => {
    const responseData = { message: 'Success!' };
    mockQuery.mockResolvedValue(responseData); // Mock successful resolution

    const mockProcedure = (input: { id: string }) => mockClient.query({ path: 'test.get', input });
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
  });

  it('should update error signal on failed fetch', async () => {
    const errorResponse: TypeQLClientError = new Error('Query Failed');
    mockQuery.mockRejectedValue(errorResponse); // Mock rejection

    const mockProcedure = (input: { id: string }) => mockClient.query({ path: 'test.get', input });
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
  });

  it('should refetch when input changes', async () => {
    const responseData1 = { id: '4', data: 'First' };
    const responseData2 = { id: '5', data: 'Second' };
    mockQuery
      .mockResolvedValueOnce(responseData1)
      .mockResolvedValueOnce(responseData2);

    const inputSignal = signal({ id: '4' }); // Use a signal for input

    const mockProcedure = (input: { id: string }) => mockClient.query({ path: 'test.get', input });
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
    expect(mockQuery).toHaveBeenCalledWith({ path: 'test.get', input: { id: '4' } });

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
    expect(mockQuery).toHaveBeenCalledWith({ path: 'test.get', input: { id: '5' } });
  });

   it('should start fetching when enabled becomes true', async () => {
       const responseData = { message: 'Fetched!' };
       mockQuery.mockResolvedValue(responseData);
       const enabledSignal = signal(false); // Start disabled

       const mockProcedure = (input: { id: string }) => mockClient.query({ path: 'test.get', input });
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
   });

});
