import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react'; // Use React Testing Library
import React, { ReactNode } from 'react'; // Import React
import { TypeQLProvider } from '../context'; // Import React context
import { useQuery } from '../hooks/useQuery'; // Import React hook
import type { createClient, TypeQLClientError } from '@sylphlab/typeql-client'; // Import createClient for ReturnType

// Use ReturnType to get the actual client type
type TypeQLClientInstance = ReturnType<typeof createClient>;

// Mock client
const mockQuery = vi.fn();
const mockClient = {
  query: mockQuery,
} as unknown as TypeQLClientInstance; // Use the inferred type

// Wrapper component providing the context (using React JSX)
const wrapper = ({ children }: { children: ReactNode }) => ( // Use ReactNode
  <TypeQLProvider client={mockClient}>{children}</TypeQLProvider>
);

describe('useQuery (React)', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockQuery.mockClear();
  });

  it('should initialize with fetching state and undefined data/error', () => {
    mockQuery.mockReturnValue(new Promise(() => {})); // Mock a pending promise

    // Pass the mock function directly as the procedure
    const { result } = renderHook(() => useQuery(mockQuery, { id: '1' }), { wrapper });

    // Access state directly (no .value)
    expect(result.current.isFetching).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
    // Check if mockQuery was called with the input
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledWith({ id: '1' });
  });

  it('should not fetch if enabled is false', () => {
     mockQuery.mockReturnValue(new Promise(() => {}));
     // Pass the mock function directly
     const { result } = renderHook(() => useQuery(mockQuery, { id: '1'}, { enabled: false }), { wrapper });

     expect(result.current.isFetching).toBe(false);
     expect(result.current.data).toBeUndefined();
     expect(result.current.error).toBeNull();
     expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should update data on successful fetch', async () => {
    const responseData = { message: 'Success!' };
    mockQuery.mockResolvedValue(responseData);

    // Pass the mock function directly
    const { result } = renderHook(() => useQuery(mockQuery, { id: '2' }), { wrapper });

    expect(result.current.isFetching).toBe(true);

    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });

    expect(result.current.data).toEqual(responseData);
    expect(result.current.error).toBeNull();
    // Check if mockQuery was called with the input
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledWith({ id: '2' });
  });

  it('should update error on failed fetch', async () => {
    const errorResponse: TypeQLClientError = new Error('Query Failed');
    mockQuery.mockRejectedValue(errorResponse);

    // Pass the mock function directly
    const { result } = renderHook(() => useQuery(mockQuery, { id: '3' }), { wrapper });

    expect(result.current.isFetching).toBe(true);

    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });

    expect(result.current.error).toEqual(errorResponse);
    expect(result.current.data).toBeUndefined();
    // Check if mockQuery was called with the input
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledWith({ id: '3' });
  });

  it('should refetch when input changes', async () => {
    const responseData1 = { id: '4', data: 'First' };
    const responseData2 = { id: '5', data: 'Second' };
    mockQuery
      .mockResolvedValueOnce(responseData1)
      .mockResolvedValueOnce(responseData2);

    // Use simple variable for input props
    let currentInput = { id: '4' };

    // Pass the mock function directly
    const { result, rerender } = renderHook(
        (props) => useQuery(mockQuery, props.input),
        {
            wrapper,
            initialProps: { input: currentInput }
        }
    );

    // Initial fetch
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.data).toEqual(responseData1);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith({ id: '4' }); // Check input directly

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
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenCalledWith({ id: '5' }); // Check input directly
  });

   it('should start fetching when enabled becomes true', async () => {
       const responseData = { message: 'Fetched!' };
       mockQuery.mockResolvedValue(responseData);
       let currentEnabled = false; // Start disabled

       // Pass the mock function directly
       const { result, rerender } = renderHook(
           (props) => useQuery(mockQuery, { id: '6' }, { enabled: props.enabled }),
           {
               wrapper,
               initialProps: { enabled: currentEnabled }
           }
       );

       expect(result.current.isFetching).toBe(false);
       expect(mockQuery).not.toHaveBeenCalled();

       // Enable the query
       currentEnabled = true;
       rerender({ enabled: currentEnabled });

       // Expect fetching state to become true
       await waitFor(() => expect(result.current.isFetching).toBe(true));
       // Wait for fetch to complete
       await waitFor(() => expect(result.current.isFetching).toBe(false));

       expect(result.current.data).toEqual(responseData);
       expect(mockQuery).toHaveBeenCalledOnce();
       expect(mockQuery).toHaveBeenCalledWith({ id: '6' }); // Check input directly
   });

});