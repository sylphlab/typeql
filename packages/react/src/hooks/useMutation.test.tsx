import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react'; // Use React Testing Library
import React, { type ReactNode } from 'react'; // Import React
import { zenQueryProvider } from '../context'; // Import React context
import { useMutation } from '../hooks/useMutation'; // Import React hook
import type { createClient, zenQueryClientError, MutationCallOptions } from '@sylphlab/zen-query-client'; // Import createClient for ReturnType

// Use ReturnType to get the actual client type
type zenQueryClientInstance = ReturnType<typeof createClient>;

// Mock client
const mockMutate = vi.fn();
const mockClient = {
  mutate: mockMutate,
} as unknown as zenQueryClientInstance; // Use the inferred type

// Wrapper component providing the context (using React JSX)
const wrapper = ({ children }: { children: ReactNode }) => ( // Use ReactNode
  <zenQueryProvider client={mockClient}>{children}</zenQueryProvider>
);

describe('useMutation (React)', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockMutate.mockClear();
  });

  it('should initialize with idle state and undefined data/error', () => {
    // Pass the mock function directly as the procedure
    const { result } = renderHook(() => useMutation(mockMutate), { wrapper });

    // Access state directly
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('should call mutation procedure and update state on successful mutateAsync', async () => {
    const responseData = { id: '123', name: 'Test Item' };
    mockMutate.mockResolvedValue(responseData); // Mock successful resolution

    // Pass the mock function directly
    const { result } = renderHook(() => useMutation(mockMutate), { wrapper });

    const variables: MutationCallOptions<{ name: string }, any> = { input: { name: 'Test Item' } };

    // Use act for triggering the async mutation
    let mutationPromise: Promise<any>;
    act(() => {
      mutationPromise = result.current.mutateAsync(variables);
    });

    // Check loading state immediately after calling mutateAsync
    expect(result.current.isLoading).toBe(true);

    // Wait for the promise returned by mutateAsync to resolve
    await mutationPromise!;

    // Wait for state updates after promise resolution
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.data).toEqual(responseData); // Data should be set now
    expect(result.current.error).toBeNull();
    expect(mockMutate).toHaveBeenCalledOnce();
    // Check if mockMutate was called with the variables object
    expect(mockMutate).toHaveBeenCalledWith(variables);
  });

  it('should update error state on failed mutateAsync', async () => {
    const errorResponse: zenQueryClientError = new Error('Mutation Failed');
    mockMutate.mockRejectedValue(errorResponse); // Mock rejection

    // Pass the mock function directly
    const { result } = renderHook(() => useMutation(mockMutate), { wrapper });

    const variables: MutationCallOptions<{ name: string }, any> = { input: { name: 'Fail Item' } };

    // Use act and catch the expected rejection
    await act(async () => {
        await expect(result.current.mutateAsync(variables)).rejects.toThrow('Mutation Failed');
    });


    // Check state after mutation fails
    expect(result.current.isLoading).toBe(false); // Should reset isLoading even on error
    expect(result.current.error).toEqual(errorResponse);
    expect(result.current.data).toBeUndefined();
    expect(mockMutate).toHaveBeenCalledOnce();
    // Check if mockMutate was called with the variables object
    expect(mockMutate).toHaveBeenCalledWith(variables);
  });

  it('should call callbacks correctly on success', async () => {
    const responseData = { id: '456' };
    mockMutate.mockResolvedValue(responseData);
    const options = {
      onMutate: vi.fn(async (vars) => {
        expect(vars.input).toEqual({ name: 'Callback Item' });
        return { contextValue: 'fromOnMutate' }; // Return context
      }),
      onSuccess: vi.fn(async (data, vars, context) => {
        expect(data).toEqual(responseData);
        expect(vars.input).toEqual({ name: 'Callback Item' });
        expect(context).toEqual({ contextValue: 'fromOnMutate' });
      }),
      onError: vi.fn(),
      onSettled: vi.fn(async (data, error, vars, context) => {
         expect(data).toEqual(responseData);
         expect(error).toBeNull();
         expect(vars.input).toEqual({ name: 'Callback Item' });
         expect(context).toEqual({ contextValue: 'fromOnMutate' });
      }),
    };

    // Pass the mock function directly
    const { result } = renderHook(() => useMutation(mockMutate, options), { wrapper });

    const variables: MutationCallOptions<{ name: string }, any> = { input: { name: 'Callback Item' } };

    await act(async () => {
        await result.current.mutateAsync(variables);
    });


    expect(options.onMutate).toHaveBeenCalledOnce();
    expect(options.onSuccess).toHaveBeenCalledOnce();
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onSettled).toHaveBeenCalledOnce();
  });

  it('should call callbacks correctly on error', async () => {
      const errorResponse = new Error('Callback Error');
      mockMutate.mockRejectedValue(errorResponse);
      const options = {
          onMutate: vi.fn(async (vars) => {
              expect(vars.input).toEqual({ name: 'Error Callback' });
              return { contextValue: 'errorMutate' };
          }),
          onSuccess: vi.fn(),
          onError: vi.fn(async (error, vars, context) => {
              expect(error).toEqual(errorResponse);
              expect(vars.input).toEqual({ name: 'Error Callback' });
              expect(context).toEqual({ contextValue: 'errorMutate' });
          }),
          onSettled: vi.fn(async (data, error, vars, context) => {
              expect(data).toBeUndefined();
              expect(error).toEqual(errorResponse);
              expect(vars.input).toEqual({ name: 'Error Callback' });
              expect(context).toEqual({ contextValue: 'errorMutate' });
          }),
      };

      // Pass the mock function directly
      const { result } = renderHook(() => useMutation(mockMutate, options), { wrapper });

      const variables: MutationCallOptions<{ name: string }, any> = { input: { name: 'Error Callback' } };

      await act(async () => {
          await expect(result.current.mutateAsync(variables)).rejects.toThrow('Callback Error');
      });

      expect(options.onMutate).toHaveBeenCalledOnce();
      expect(options.onSuccess).not.toHaveBeenCalled();
      expect(options.onError).toHaveBeenCalledOnce();
      expect(options.onSettled).toHaveBeenCalledOnce();
  });


  it('should reset state when reset is called', async () => {
    const responseData = { id: '789' };
    mockMutate.mockResolvedValue(responseData);

    // Pass the mock function directly
    const { result } = renderHook(() => useMutation(mockMutate), { wrapper });

    const variables: MutationCallOptions<{ name: string }, any> = { input: { name: 'Reset Item' } };

    // Mutate successfully
    await act(async () => {
        await result.current.mutateAsync(variables);
    });


    expect(result.current.data).toEqual(responseData);
    expect(result.current.isLoading).toBe(false);

    // Reset
    act(() => {
      result.current.reset();
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  // TODO: Add tests for optimistic updates if store is provided
});