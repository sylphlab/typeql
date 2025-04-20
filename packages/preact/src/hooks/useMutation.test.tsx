import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/preact';
import { h } from 'preact';
import { TypeQLProvider } from '../context';
import { useMutation } from './useMutation';
import type { TypeQLClient, TypeQLClientError, MutationCallOptions } from '@sylphlab/typeql-client';

// Mock client
const mockMutate = vi.fn();
const mockClient = {
  mutate: mockMutate,
  // Add other methods if needed
} as unknown as TypeQLClient<any>;

// Wrapper component providing the context
const wrapper = ({ children }: { children: any }) =>
  h(TypeQLProvider, { client: mockClient }, children);

describe('useMutation', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockMutate.mockClear();
  });

  it('should initialize with idle state and undefined data/error', () => {
    const mockProcedure = (opts: MutationCallOptions<{ name: string }, any>) => mockClient.mutate({ path: 'test.create', ...opts });
    const { result } = renderHook(() => useMutation(mockProcedure), { wrapper });

    expect(result.current.isLoading.value).toBe(false);
    expect(result.current.data.value).toBeUndefined();
    expect(result.current.error.value).toBeNull();
  });

  it('should call mutation procedure and update state on successful mutateAsync', async () => {
    const responseData = { id: '123', name: 'Test Item' };
    mockMutate.mockResolvedValue(responseData); // Mock successful resolution

    const mockProcedure = (opts: MutationCallOptions<{ name: string }, any>) => mockClient.mutate({ path: 'test.create', ...opts });
    const { result } = renderHook(() => useMutation(mockProcedure), { wrapper });

    const variables: MutationCallOptions<{ name: string }, any> = { input: { name: 'Test Item' } };

    // Use act for triggering the async mutation
    let mutationPromise: Promise<any>;
    act(() => {
      mutationPromise = result.current.mutateAsync(variables);
    });

    // Check loading state immediately after calling mutateAsync
    expect(result.current.isLoading.value).toBe(true);

    // Wait for the promise returned by mutateAsync to resolve
    await mutationPromise!;

    // Check state after mutation completes
    expect(result.current.isLoading.value).toBe(false);
    expect(result.current.data.value).toEqual(responseData);
    expect(result.current.error.value).toBeNull();
    expect(mockMutate).toHaveBeenCalledOnce();
    expect(mockMutate).toHaveBeenCalledWith({ path: 'test.create', input: variables.input });
  });

  it('should update error state on failed mutateAsync', async () => {
    const errorResponse: TypeQLClientError = new Error('Mutation Failed');
    mockMutate.mockRejectedValue(errorResponse); // Mock rejection

    const mockProcedure = (opts: MutationCallOptions<{ name: string }, any>) => mockClient.mutate({ path: 'test.create', ...opts });
    const { result } = renderHook(() => useMutation(mockProcedure), { wrapper });

    const variables: MutationCallOptions<{ name: string }, any> = { input: { name: 'Fail Item' } };

    // Use act and catch the expected rejection
    await act(async () => {
        await expect(result.current.mutateAsync(variables)).rejects.toThrow('Mutation Failed');
    });


    // Check state after mutation fails
    expect(result.current.isLoading.value).toBe(false); // Should reset isLoading even on error
    expect(result.current.error.value).toEqual(errorResponse);
    expect(result.current.data.value).toBeUndefined();
    expect(mockMutate).toHaveBeenCalledOnce();
    expect(mockMutate).toHaveBeenCalledWith({ path: 'test.create', input: variables.input });
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

    const mockProcedure = (opts: MutationCallOptions<{ name: string }, any>) => mockClient.mutate({ path: 'test.callback', ...opts });
    const { result } = renderHook(() => useMutation(mockProcedure, options), { wrapper });

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

      const mockProcedure = (opts: MutationCallOptions<{ name: string }, any>) => mockClient.mutate({ path: 'test.errorback', ...opts });
      const { result } = renderHook(() => useMutation(mockProcedure, options), { wrapper });

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

    const mockProcedure = (opts: MutationCallOptions<{ name: string }, any>) => mockClient.mutate({ path: 'test.reset', ...opts });
    const { result } = renderHook(() => useMutation(mockProcedure), { wrapper });

    const variables: MutationCallOptions<{ name: string }, any> = { input: { name: 'Reset Item' } };

    // Mutate successfully
    await act(async () => {
        await result.current.mutateAsync(variables);
    });


    expect(result.current.data.value).toEqual(responseData);
    expect(result.current.isLoading.value).toBe(false);

    // Reset
    act(() => {
      result.current.reset();
    });

    expect(result.current.data.value).toBeUndefined();
    expect(result.current.error.value).toBeNull();
    expect(result.current.isLoading.value).toBe(false);
  });

  // TODO: Add tests for optimistic updates if store is provided
});
