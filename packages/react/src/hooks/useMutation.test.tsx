{/* packages/react/src/hooks/useMutation.test.tsx */}
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, Mock, afterAll } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom'; // Ensure matchers are available via setup

// Import hook under test and provider/context
import { useMutation, UseMutationOptions, UseMutationResult } from './useMutation'; // Import hook and types
import { TypeQLProvider } from '../context'; // Import provider
import { createClient, OptimisticStore, PredictedChange } from '@sylphlab/typeql-client';
import { TypeQLClientError } from '@sylphlab/typeql-shared';

// --- Mocks ---
const mockTransport = { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn() };
const mockClient = createClient({ transport: mockTransport as any });

// Mock Store (only need subscribe for provider, addPendingMutation might be called by client proxy mock)
const getOptimisticStateMock = vi.fn(() => ({}));
const subscribeMock = vi.fn(() => () => {});
const addPendingMutationMock = vi.fn(); // Mock this as the client proxy's mutate might call it

const mockStore: OptimisticStore<any> = {
    getOptimisticState: getOptimisticStateMock,
    subscribe: subscribeMock,
    addPendingMutation: addPendingMutationMock,
    // Add other methods as needed, potentially mocking them if called by client proxy
    applyServerDelta: vi.fn(),
    getConfirmedState: vi.fn(() => ({})),
    getConfirmedServerSeq: vi.fn(() => 0),
    getPendingMutations: vi.fn(() => []),
    rejectPendingMutation: vi.fn(),
    confirmPendingMutation: vi.fn(),
};

// --- Test Setup ---
describe('useMutation', () => {
    // Mock the actual procedure method that useMutation will call
    const mockProcedureMutate = vi.fn();
    const mockMutationProcedure = { mutate: mockProcedureMutate };

    const mockInput = { name: 'New Item' };
    const mockOutput = { id: 2, name: 'New Item' };
    const mockError = new Error('Mutation Failed');
    const mockOptimisticChange: PredictedChange<any> = (currentState: any) => ({
        ...currentState,
        items: [...(currentState?.items || []), { id: 'temp-2', name: 'New Item (Optimistic)' }]
    });

    beforeEach(() => {
      vi.resetAllMocks();
      getOptimisticStateMock.mockReturnValue({});
      subscribeMock.mockClear();
      addPendingMutationMock.mockClear(); // Clear this mock too
    });

    afterEach(() => {
        cleanup();
    });

    // Helper component to read hook state
    interface MutationRunnerProps<TOutput, TInput, TState> {
        procedure: typeof mockMutationProcedure;
        options?: UseMutationOptions<TOutput, TInput, TState>;
        onStateChange: (state: UseMutationResult<TOutput, TInput, TState>) => void;
        mutateRef: React.MutableRefObject<null | ((input: TInput) => Promise<TOutput>)>; // Use React ref type
    }
    const MutationRunner = <TOutput, TInput, TState>({ procedure, options, onStateChange, mutateRef }: MutationRunnerProps<TOutput, TInput, TState>) => {
        const mutationResult = useMutation(procedure, options);
        // Use effect to report state changes reliably after render
        React.useEffect(() => {
            onStateChange(mutationResult);
        });
        // Assign mutate function to the ref
        mutateRef.current = mutationResult.mutate;
        return <div data-testid="mutation-status">{mutationResult.status}</div>;
    };

    // Helper to render the hook and capture state changes
    const renderMutationHook = <TOutput = any, TInput = any, TState = any>(
        props: Omit<MutationRunnerProps<TOutput, TInput, TState>, 'onStateChange' | 'mutateRef'> & { onStateChange?: (state: UseMutationResult<TOutput, TInput, TState>) => void }
    ) => {
        const stateChanges: UseMutationResult<TOutput, TInput, TState>[] = [];
        const onStateChange = props.onStateChange ?? ((state: UseMutationResult<TOutput, TInput, TState>) => stateChanges.push(state));
        const mutateRef = React.createRef<null | ((input: TInput) => Promise<TOutput>)>(); // Use React.createRef
        const renderResult = render(
             <TypeQLProvider client={{ ...mockClient, testMutation: mockMutationProcedure } as any} store={mockStore}>
                 <MutationRunner {...props} onStateChange={onStateChange} mutateRef={mutateRef} />
             </TypeQLProvider>
        );
        // Function to get the latest state captured
        const getLatestState = () => stateChanges[stateChanges.length - 1];
        const getMutateFn = () => mutateRef.current;
        return { ...renderResult, stateChanges, getLatestState, getMutateFn };
    };

    // --- Tests ---

    it('should be in idle state initially', () => {
      const { getLatestState } = renderMutationHook({ procedure: mockMutationProcedure });
      // Wait for initial render cycle
      expect(getLatestState()).toBeDefined();
      const initialState = getLatestState();
      expect(initialState.isLoading).toBe(false);
      expect(initialState.isSuccess).toBe(false);
      expect(initialState.isError).toBe(false);
      expect(initialState.status).toBe('idle');
      expect(initialState.data).toBeUndefined();
      expect(initialState.error).toBeNull();
    });

    it('should enter loading state and call procedure on mutate', async () => {
      mockProcedureMutate.mockResolvedValueOnce(mockOutput);
      const { getLatestState, getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure });

      await waitFor(() => expect(getMutateFn()).toBeInstanceOf(Function)); // Wait for ref to be set
      const mutateFn = getMutateFn();

      let mutationPromise: Promise<any> | undefined;

      // Trigger the mutation (returns a promise)
      // No act needed here just to *call* it, but updates need act
      mutationPromise = mutateFn!(mockInput);

      // Assert loading state immediately after calling mutateFn
      // State update might be slightly delayed, so use waitFor
      await waitFor(() => {
          expect(getLatestState().status).toBe('loading');
          expect(getLatestState().isLoading).toBe(true);
      });

      // Wrap the promise settlement and subsequent state updates in act
      await act(async () => {
          await mutationPromise;
      });

      // Wait for the final success state
      await waitFor(() => {
          expect(getLatestState().status).toBe('success');
      });

      const finalState = getLatestState();
      // Verify the *mocked procedure* was called correctly
      expect(mockProcedureMutate).toHaveBeenCalledWith({ input: mockInput }); // Check args passed to mock
      expect(finalState.isLoading).toBe(false);
      expect(finalState.status).toBe('success');
      expect(finalState.data).toEqual(mockOutput);
    });

     it('should handle mutation errors', async () => {
      mockProcedureMutate.mockRejectedValueOnce(mockError);
      const { getLatestState, getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure });

      await waitFor(() => expect(getMutateFn()).toBeInstanceOf(Function));
      const mutateFn = getMutateFn();

      let mutationPromise: Promise<any> | undefined;

      // Trigger the mutation and attach catch
      // No act needed here just to *call* it
      mutationPromise = mutateFn!(mockInput).catch(() => {}); // Catch expected rejection

      // Assert loading state immediately after calling mutateFn
      await waitFor(() => {
          expect(getLatestState().status).toBe('loading');
      });

      // Wrap the promise settlement (rejection) and subsequent state updates in act
      await act(async () => {
          await mutationPromise;
      });

      // Wait for the final error state
      await waitFor(() => {
          expect(getLatestState().status).toBe('error');
      });

      const finalState = getLatestState();
      expect(mockProcedureMutate).toHaveBeenCalledWith({ input: mockInput });
      expect(finalState.isLoading).toBe(false);
      expect(finalState.status).toBe('error');
      expect(finalState.data).toBeUndefined();
      expect(finalState.error).toEqual(mockError);
    });

    it('should call onSuccess callback on successful mutation', async () => {
      const onSuccessMock = vi.fn();
      mockProcedureMutate.mockResolvedValueOnce(mockOutput);
      const { getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure, options: { onSuccess: onSuccessMock } });

      await waitFor(() => expect(getMutateFn()).toBeInstanceOf(Function));
      const mutateFn = getMutateFn();

      await act(async () => { await mutateFn!(mockInput); });

      // Wait for potential async nature of onSuccess
      await waitFor(() => {
          expect(onSuccessMock).toHaveBeenCalledWith(mockOutput, mockInput);
      });
    });

    it('should call onError callback on failed mutation', async () => {
      const onErrorMock = vi.fn();
      mockProcedureMutate.mockRejectedValueOnce(mockError);
      const { getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure, options: { onError: onErrorMock } });

      await waitFor(() => expect(getMutateFn()).toBeInstanceOf(Function));
      const mutateFn = getMutateFn();

      await act(async () => { await mutateFn!(mockInput).catch(() => {}); });

      await waitFor(() => {
          expect(onErrorMock).toHaveBeenCalledWith(mockError, mockInput);
      });
    });

     it('should call onMutate callback before mutation', async () => {
      const onMutateMock = vi.fn();
      mockProcedureMutate.mockResolvedValueOnce(mockOutput);
      const { getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure, options: { onMutate: onMutateMock } });

      await waitFor(() => expect(getMutateFn()).toBeInstanceOf(Function));
      const mutateFn = getMutateFn();

      await act(async () => { await mutateFn!(mockInput); });

      // onMutate should be called before the actual procedure mock
      expect(onMutateMock).toHaveBeenCalledWith(mockInput);
      expect(onMutateMock).toHaveBeenCalledBefore(mockProcedureMutate);
      expect(mockProcedureMutate).toHaveBeenCalledWith({ input: mockInput });
    });

    it('should reset state when reset is called', async () => {
      mockProcedureMutate.mockResolvedValueOnce(mockOutput);
      const { getLatestState, getMutateFn } = renderMutationHook({ procedure: mockMutationProcedure });

      await waitFor(() => expect(getMutateFn()).toBeInstanceOf(Function));
      const mutateFn = getMutateFn();

      await act(async () => { await mutateFn!(mockInput); });
      await waitFor(() => { expect(getLatestState().status).toBe('success'); });
      expect(getLatestState().data).toEqual(mockOutput);

      let resetFn: (() => void) | undefined;
      await waitFor(() => {
          resetFn = getLatestState().reset;
          expect(resetFn).toBeInstanceOf(Function);
      });

      act(() => { resetFn!(); });

      // Wait for state to update after reset
      await waitFor(() => {
          expect(getLatestState().status).toBe('idle');
      });

      const finalState = getLatestState();
      expect(finalState.isLoading).toBe(false);
      expect(finalState.isSuccess).toBe(false);
      expect(finalState.isError).toBe(false);
      expect(finalState.status).toBe('idle');
      expect(finalState.data).toBeUndefined();
      expect(finalState.error).toBeNull();
    });

    it('should pass optimistic options to procedure.mutate if provided', async () => {
        mockProcedureMutate.mockResolvedValueOnce(mockOutput);
        const { getMutateFn } = renderMutationHook({
            procedure: mockMutationProcedure,
            options: { optimistic: { predictedChange: mockOptimisticChange } }
        });

        await waitFor(() => expect(getMutateFn()).toBeInstanceOf(Function));
        const mutateFn = getMutateFn();

        await act(async () => { await mutateFn!(mockInput); });

        // Check that the *mocked procedure* received the correct arguments
        expect(mockProcedureMutate).toHaveBeenCalledWith({
            input: mockInput,
            optimistic: { predictedChange: mockOptimisticChange }
        });
        // Optionally, check if addPendingMutation was called by the (mocked) client proxy
        // expect(addPendingMutationMock).toHaveBeenCalled();
    });
}); // End of useMutation describe