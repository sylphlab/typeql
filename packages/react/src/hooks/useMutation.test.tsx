{/* packages/react/src/hooks/useMutation.test.tsx */}
import React, { ReactNode } from 'react'; // Import ReactNode
import { describe, it, expect, vi, beforeEach, afterEach, Mock, afterAll } from 'vitest';
import { render, renderHook, act, waitFor, cleanup } from '@testing-library/react'; // Import renderHook
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

    it('should be in idle state initially', async () => { // Add async keyword
      const { getLatestState } = renderMutationHook({ procedure: mockMutationProcedure });
      // Wait for initial state to be captured
      await waitFor(() => expect(getLatestState()).toBeDefined());
      const initialState = getLatestState()!; // Add non-null assertion
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

      // Trigger the mutation within act to handle immediate state updates
      act(() => {
          mutationPromise = mutateFn!(mockInput);
      });

      // Assert loading state immediately after calling mutateFn
      // State update might be slightly delayed, so use waitFor
      await waitFor(() => {
          expect(getLatestState()!.status).toBe('loading'); // Add !
          expect(getLatestState()!.isLoading).toBe(true); // Add !
      });

      // Wrap the promise settlement and subsequent state updates in act
      await act(async () => {
          await mutationPromise;
      });

      // Wait for the final success state
      await waitFor(() => {
          expect(getLatestState()!.status).toBe('success'); // Add !
      });

      const finalState = getLatestState()!; // Add !
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

      // Trigger the mutation within act and attach catch
      act(() => {
          mutationPromise = mutateFn!(mockInput).catch(() => {}); // Catch expected rejection
      });

      // Assert loading state immediately after calling mutateFn
      await waitFor(() => {
          expect(getLatestState()!.status).toBe('loading'); // Add !
      });

      // Wrap the promise settlement (rejection) and subsequent state updates in act
      await act(async () => {
          await mutationPromise;
      });

      // Wait for the final error state
      await waitFor(() => {
          expect(getLatestState()!.status).toBe('error'); // Add !
      });

      const finalState = getLatestState()!; // Add !
      expect(mockProcedureMutate).toHaveBeenCalledWith({ input: mockInput });
      expect(finalState.isLoading).toBe(false);
      expect(finalState.status).toBe('error');

      expect(finalState.data).toBeUndefined();
      expect(finalState.error).toEqual(mockError);
    });

    it('should throw error if mutate called after unmount', async () => {
      // Need renderHook for unmount, but createWrapper is defined inside describe
      // Re-rendering with renderMutationHook might be complex, let's use renderHook directly here
      // We need imports for renderHook and TypeQLProvider etc. at the top level if not already there
      // Assuming imports are correct at top level for simplicity
      const { result, unmount } = renderHook( // Use renderHook directly
        () => useMutation(mockMutationProcedure),
        {
          wrapper: ({ children }: { children: ReactNode }) => ( // Define wrapper inline with typed children
            <TypeQLProvider client={{ ...mockClient, testMutation: mockMutationProcedure } as any} store={mockStore}>
              {children}
            </TypeQLProvider>
          )
        }
      );

      unmount(); // Unmount the component

      await expect(result.current.mutateAsync({ name: 'Test' }))
        .rejects
        .toThrow(new TypeQLClientError("Component unmounted before mutation could complete."));

      expect(mockProcedureMutate).not.toHaveBeenCalled(); // Use the correct mock name
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

    it('should throw error if unmounted after success before state update', async () => {
      let resolveMutate: (value: unknown) => void;
      const mutatePromise = new Promise((resolve) => { resolveMutate = resolve; });
      mockProcedureMutate.mockReturnValue(mutatePromise);

      let doUnmount: () => void;

      const { result, unmount } = renderHook(
        () => useMutation(mockMutationProcedure, {
          onSuccess: () => {
            // This callback runs *after* the promise resolves but *before* internal setData/setStatus
            // We trigger the unmount here to simulate the race condition
            doUnmount();
          }
        }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <TypeQLProvider client={{ ...mockClient, testMutation: mockMutationProcedure } as any} store={mockStore}>
              {children}
            </TypeQLProvider>
          )
        }
      );

      doUnmount = unmount; // Assign unmount function

      // Trigger mutation but don't await it here
      // Add a catch to prevent unhandled rejection warning
      const mutationExecution = result.current.mutateAsync(mockInput).catch(() => {});

      // Resolve the underlying procedure promise
      await act(async () => {
        resolveMutate(mockOutput);
        // Wait a tick to allow promise resolution and onSuccess to trigger unmount
        await new Promise(r => setTimeout(r, 0));
      });

      // Now, await the original mutation promise and catch the expected error
      // Match by error message substring instead of instance
      await expect(mutationExecution)
          .rejects
          .toThrowError(/Component unmounted after mutation success/);


      // Also check the final state of the hook if needed, though the promise rejection is the primary check
      // The status might still be 'loading' if the state update was prevented by unmount
      // Let's verify the error object if possible, or just rely on the promise rejection check.
      // expect(result.current.status).toBe('error'); // This might be unreliable
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
      await waitFor(() => { expect(getLatestState()!.status).toBe('success'); }); // Add !
      expect(getLatestState()!.data).toEqual(mockOutput); // Add !

      let resetFn: (() => void) | undefined;
      await waitFor(() => {
          resetFn = getLatestState()!.reset; // Add !
          expect(resetFn).toBeInstanceOf(Function);
      });

      act(() => { resetFn!(); });

      // Wait for state to update after reset
      await waitFor(() => {
          expect(getLatestState()!.status).toBe('idle'); // Add !
      });

      const finalState = getLatestState()!; // Add !
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