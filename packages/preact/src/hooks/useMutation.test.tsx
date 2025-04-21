import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/preact';
import { h } from 'preact';
import { zenQueryProvider } from '../context';
import { useMutation } from './useMutation';
// Import types correctly
import type { ZenQueryClient, OptimisticSyncCoordinator } from '@sylphlab/zen-query-client';
import type { zenQueryClientError } from '@sylphlab/zen-query-shared';
// Removed MutationCallOptions import

// Mock client (complete structure)
const mockQuery = vi.fn();
const mockMutate = vi.fn(); // Specific mock for mutation procedures
const mockSubscription = vi.fn();

const mockEmitter = {
    on: vi.fn(),
    emit: vi.fn(),
};

const mockGetCoordinator = vi.fn(() => ({
    // Methods
    on: mockEmitter.on,
    generateClientSeq: vi.fn(() => 12345), // Return a consistent mock seq
    registerPendingMutation: vi.fn(),
    confirmMutation: vi.fn(),
    rejectMutation: vi.fn(),
    processServerDelta: vi.fn(),
    getPendingPatches: vi.fn(() => new Map()),
    getConfirmedServerSeq: vi.fn(() => 0),
    hasPendingMutations: vi.fn(() => false),
    // Properties required by type
    confirmedServerSeq: 0,
    clientSeqCounter: 0,
    pendingMutations: [],
    emitter: mockEmitter,
} as unknown as OptimisticSyncCoordinator));

// Define type for the mutation part of the mock
type MockMutationProcedures = {
    [key: string]: Mock; // Use simple Mock type
};

const mockClient: ZenQueryClient = {
  query: { } as any,
  mutation: { // Use flattened path as key
      'test.create': mockMutate,
      'test.callback': mockMutate,
      'test.errorback': mockMutate,
      'test.reset': mockMutate,
  } as MockMutationProcedures,
  subscription: { } as any,
  getCoordinator: mockGetCoordinator,
  close: vi.fn(),
};

// Wrapper component providing the context
const wrapper = ({ children }: { children: any }) =>
  h(zenQueryProvider, { client: mockClient, children }); // Correct h usage

describe('useMutation', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mockMutate.mockClear();
    vi.mocked(mockGetCoordinator().emitter.on).mockClear();
    vi.mocked(mockGetCoordinator().on).mockClear();
    vi.mocked(mockGetCoordinator().registerPendingMutation).mockClear();
  });

  it('should initialize with idle state and undefined data/error', () => {
    // Access mock procedure correctly
    const mockProcedure = (input: { name: string }) => mockClient.mutation['test.create']!(input);
    const { result } = renderHook(() => useMutation(mockProcedure), { wrapper });

    expect(result.current.isLoading.value).toBe(false);
    expect(result.current.data.value).toBeUndefined();
    expect(result.current.error.value).toBeNull();
  });

  it('should call mutation procedure and update state on successful mutateAsync', async () => {
    const responseData = { id: '123', name: 'Test Item' };
    mockMutate.mockResolvedValue(responseData); // Mock successful resolution

    // Access mock procedure correctly
    const mockProcedure = (input: { name: string }) => mockClient.mutation['test.create']!(input);
    const { result } = renderHook(() => useMutation(mockProcedure), { wrapper });

    const variables = { name: 'Test Item' }; // Use TInput directly

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
    // The hook now passes the raw input to the procedure mock
    expect(mockMutate).toHaveBeenCalledWith(variables);
  });

  it('should update error state on failed mutateAsync', async () => {
    const errorResponse: zenQueryClientError = new Error('Mutation Failed');
    mockMutate.mockRejectedValue(errorResponse); // Mock rejection

    // Access mock procedure correctly
    const mockProcedure = (input: { name: string }) => mockClient.mutation['test.create']!(input);
    const { result } = renderHook(() => useMutation(mockProcedure), { wrapper });

    const variables = { name: 'Fail Item' }; // Use TInput directly

    // Use act and catch the expected rejection
    await act(async () => {
        await expect(result.current.mutateAsync(variables)).rejects.toThrow('Mutation Failed');
    });


    // Check state after mutation fails
    expect(result.current.isLoading.value).toBe(false); // Should reset isLoading even on error
    expect(result.current.error.value).toEqual(errorResponse);
    expect(result.current.data.value).toBeUndefined();
    expect(mockMutate).toHaveBeenCalledOnce();
    expect(mockMutate).toHaveBeenCalledWith(variables);
  });

  it('should call callbacks correctly on success', async () => {
    const responseData = { id: '456' };
    mockMutate.mockResolvedValue(responseData);
    const options = {
      onMutate: vi.fn(async (vars) => { // vars is TInput
        expect(vars).toEqual({ name: 'Callback Item' });
        return { contextValue: 'fromOnMutate' }; // Return context
      }),
      onSuccess: vi.fn(async (data, vars, context) => { // vars is TInput
        expect(data).toEqual(responseData);
        expect(vars).toEqual({ name: 'Callback Item' });
        expect(context).toEqual({ contextValue: 'fromOnMutate' });
      }),
      onError: vi.fn(),
      onSettled: vi.fn(async (data, error, vars, context) => { // vars is TInput
         expect(data).toEqual(responseData);
         expect(error).toBeNull();
         expect(vars).toEqual({ name: 'Callback Item' });
         expect(context).toEqual({ contextValue: 'fromOnMutate' });
      }),
    };

    // Access mock procedure correctly
    const mockProcedure = (input: { name: string }) => mockClient.mutation['test.callback']!(input);
    const { result } = renderHook(() => useMutation(mockProcedure, options), { wrapper });

    const variables = { name: 'Callback Item' }; // Use TInput directly

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
          onMutate: vi.fn(async (vars) => { // vars is TInput
              expect(vars).toEqual({ name: 'Error Callback' });
              return { contextValue: 'errorMutate' };
          }),
          onSuccess: vi.fn(),
          onError: vi.fn(async (error, vars, context) => { // vars is TInput
              expect(error).toEqual(errorResponse);
              expect(vars).toEqual({ name: 'Error Callback' });
              expect(context).toEqual({ contextValue: 'errorMutate' });
          }),
          onSettled: vi.fn(async (data, error, vars, context) => { // vars is TInput
              expect(data).toBeUndefined();
              expect(error).toEqual(errorResponse);
              expect(vars).toEqual({ name: 'Error Callback' });
              expect(context).toEqual({ contextValue: 'errorMutate' });
          }),
      };

      // Access mock procedure correctly
      const mockProcedure = (input: { name: string }) => mockClient.mutation['test.errorback']!(input);
      const { result } = renderHook(() => useMutation(mockProcedure, options), { wrapper });

      const variables = { name: 'Error Callback' }; // Use TInput directly

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

    // Access mock procedure correctly
    const mockProcedure = (input: { name: string }) => mockClient.mutation['test.reset']!(input);
    const { result } = renderHook(() => useMutation(mockProcedure), { wrapper });

    const variables = { name: 'Reset Item' }; // Use TInput directly

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
