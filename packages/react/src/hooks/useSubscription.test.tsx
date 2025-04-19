{/* packages/react/src/hooks/useSubscription.test.tsx */}
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, Mock, afterAll } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom'; // Ensure matchers are available via setup

// Import hook under test and provider/context
import { useSubscription, UseSubscriptionOptions, UseSubscriptionResult } from './useSubscription'; // Import hook and types
import { TypeQLProvider } from '../context'; // Import provider
import { createClient, OptimisticStore, StoreListener } from '@sylphlab/typeql-client';
import { SubscriptionDataMessage, SubscriptionErrorMessage, TypeQLClientError, UnsubscribeFn } from '@sylphlab/typeql-shared';

// --- Mocks ---
const mockTransport = { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn() };
const mockClient = createClient({ transport: mockTransport as any });

// Mock Store
const getOptimisticStateMock = vi.fn(() => ({}));
const subscribeMock = vi.fn(() => () => {}); // Store subscribe
const applyServerDeltaMock = vi.fn();
const getConfirmedStateMock = vi.fn(() => ({}));
const getConfirmedServerSeqMock = vi.fn(() => 0);
const getPendingMutationsMock = vi.fn(() => []);
const addPendingMutationMock = vi.fn();
const rejectPendingMutationMock = vi.fn();
const confirmPendingMutationMock = vi.fn();

const mockStore: OptimisticStore<any> = {
    getOptimisticState: getOptimisticStateMock,
    subscribe: subscribeMock,
    applyServerDelta: applyServerDeltaMock,
    getConfirmedState: getConfirmedStateMock,
    getConfirmedServerSeq: getConfirmedServerSeqMock,
    getPendingMutations: getPendingMutationsMock,
    addPendingMutation: addPendingMutationMock,
    rejectPendingMutation: rejectPendingMutationMock,
    confirmPendingMutation: confirmPendingMutationMock,
};

// --- Test Setup ---
describe('useSubscription', () => {
    // Mock Async Iterator Setup
    let mockIteratorController: {
        push: (value: SubscriptionDataMessage | SubscriptionErrorMessage) => void;
        end: () => void;
        error: (err: Error) => void;
    };
    let mockUnsubscribeFn: Mock<() => void>; // Try function signature as single type arg

    const mockSubscriptionProcedure = {
      subscribe: vi.fn((_input: any) => { // Underscore input as it's not used in mock logic
        const buffer: (SubscriptionDataMessage | SubscriptionErrorMessage)[] = [];
        let resolveNext: ((value: IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>) => void) | null = null;
        let rejectNext: ((reason?: any) => void) | null = null;
        let ended = false;

        // Define controller inside the mock function scope
        mockIteratorController = {
            push: (value) => {
                if (resolveNext) {
                    resolveNext({ value, done: false });
                    resolveNext = null;
                    rejectNext = null;
                } else {
                    buffer.push(value);
                }
            },
            end: () => {
                ended = true;
                if (resolveNext) {
                    resolveNext({ value: undefined, done: true });
                    resolveNext = null;
                    rejectNext = null;
                }
            },
            error: (err) => {
                ended = true;
                if (rejectNext) {
                    rejectNext(err);
                    resolveNext = null;
                    rejectNext = null;
                } else {
                    // If error happens before next() is called, push an error message
                    // This might not be the exact behavior, adjust if needed
                    buffer.push({ type: 'subscriptionError', id: 'ctrl-error-id', error: { message: err.message } });
                }
            }
        };

        const iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> = {
            async next() {
                if (buffer.length > 0) {
                    const value = buffer.shift()!;
                    // Don't need special handling for error type here, just return it
                    return { value, done: false };
                }
                if (ended) {
                    return { value: undefined, done: true };
                }
                return new Promise((resolve, reject) => {
                    resolveNext = resolve;
                    rejectNext = reject;
                });
            },
            [Symbol.asyncIterator]() { return this; },
        };

        // Define unsubscribe inside the mock function scope
        mockUnsubscribeFn = vi.fn(() => {
            // console.log("[TEST] Mock unsubscribe called");
            mockIteratorController?.end(); // Use optional chaining
        });

        return { iterator, unsubscribe: mockUnsubscribeFn };
      }),
    };

    // Test Data
    const mockInput = { topic: 'updates' };
    const mockData1: SubscriptionDataMessage = { type: 'subscriptionData', id: 'mock-data-1', data: { message: 'Update 1' }, serverSeq: 1 };
    const mockData2: SubscriptionDataMessage = { type: 'subscriptionData', id: 'mock-data-2', data: { message: 'Update 2' }, serverSeq: 2 };
    const mockSubErrorMsg: SubscriptionErrorMessage = { type: 'subscriptionError', id: 'mock-sub-error-id', error: { message: 'Subscription Failed Internally' } };
    const mockIteratorError = new Error('Iterator Failed');

    beforeEach(() => {
      vi.resetAllMocks();
      getOptimisticStateMock.mockReturnValue({});
      applyServerDeltaMock.mockClear();
      mockSubscriptionProcedure.subscribe.mockClear();
      // mockUnsubscribeFn is defined within the subscribe mock, clear its calls if needed
      mockUnsubscribeFn?.mockClear();
    });

    // Helper component
    interface SubscriptionViewerProps<TOutput> {
        procedure: typeof mockSubscriptionProcedure;
        input: typeof mockInput;
        options?: UseSubscriptionOptions<TOutput>;
        onStateChange: (state: UseSubscriptionResult<TOutput>) => void;
    }
    const SubscriptionViewer = <TOutput,>({ procedure, input, options, onStateChange }: SubscriptionViewerProps<TOutput>) => {
        const subResult = useSubscription(procedure, input, options);
        React.useEffect(() => {
            onStateChange(subResult);
        });
        return <div data-testid="sub-status">{subResult.status}</div>;
    };

    // Render helper
    const renderSubscriptionHook = <TOutput = any>(
        props: Omit<SubscriptionViewerProps<TOutput>, 'onStateChange'> & { onStateChange?: (state: UseSubscriptionResult<TOutput>) => void }
    ) => {
        const stateChanges: UseSubscriptionResult<TOutput>[] = [];
        const onStateChange = props.onStateChange ?? ((state: UseSubscriptionResult<TOutput>) => stateChanges.push(state));
        const renderResult = render(
             <TypeQLProvider client={{ ...mockClient, testSub: mockSubscriptionProcedure } as any} store={mockStore}>
                 <SubscriptionViewer {...props} onStateChange={onStateChange} />
             </TypeQLProvider>
        );
        const getLatestState = () => stateChanges[stateChanges.length - 1];
        return { ...renderResult, stateChanges, getLatestState };
    };

    // --- Tests ---

    it('should initially be in connecting state when enabled', async () => { // Add async
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput });
      // Wait for initial state to be captured
      await waitFor(() => expect(getLatestState()).toBeDefined());
      const initialState = getLatestState()!; // Add !
      expect(initialState.status).toBe('connecting');
      expect(initialState.data).toBeNull();
      expect(initialState.error).toBeNull();
      expect(mockSubscriptionProcedure.subscribe).toHaveBeenCalledWith(mockInput);
    });

    it('should transition to active state and receive data, calling onData and applyServerDelta', async () => {
      const onDataMock = vi.fn();
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { onData: onDataMock } });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting')); // Add ! Ensure connection starts

      // Push first data message
      await act(async () => { mockIteratorController.push(mockData1); });

      // Wait for state transition and data processing
      await waitFor(() => {
          expect(getLatestState()!.status).toBe('active'); // Add !
          expect(getLatestState()!.data).toEqual(mockData1.data); // Add !
      });

      const activeState1 = getLatestState()!; // Add !
      expect(activeState1.error).toBeNull();
      expect(onDataMock).toHaveBeenCalledWith(mockData1.data);
      expect(applyServerDeltaMock).toHaveBeenCalledWith(mockData1); // Verify store interaction

      // Push second data message
      await act(async () => { mockIteratorController.push(mockData2); });

      await waitFor(() => {
          expect(getLatestState()!.data).toEqual(mockData2.data); // Add !
      });

      const activeState2 = getLatestState()!; // Add !
      expect(activeState2.status).toBe('active'); // Should remain active
      expect(activeState2.error).toBeNull();
      expect(onDataMock).toHaveBeenCalledWith(mockData2.data);
      expect(applyServerDeltaMock).toHaveBeenCalledWith(mockData2); // Verify store interaction again
    });

    it('should handle subscription error messages from iterator', async () => {
      const onErrorMock = vi.fn();
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { onError: onErrorMock } });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting')); // Add !

      // Push error message
      // Push error message within act
      await act(async () => { mockIteratorController.push(mockSubErrorMsg); });

      // Wait specifically for the error status and error object
      await waitFor(() => {
          const latestState = getLatestState()!;
          expect(latestState.status).toBe('error');
          expect(latestState.error).toBeInstanceOf(TypeQLClientError);
          expect(latestState.error?.message).toBe(mockSubErrorMsg.error.message);
      });

      const errorState = getLatestState()!; // Re-fetch state after waiting
      expect(errorState.error).toBeInstanceOf(TypeQLClientError);
      expect(errorState.error?.message).toBe(mockSubErrorMsg.error.message);
      expect(onErrorMock).toHaveBeenCalledWith(mockSubErrorMsg.error); // Pass original error structure
    });

     it('should handle iterator errors (e.g., network failure)', async () => {
      const onErrorMock = vi.fn();
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { onError: onErrorMock } });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting')); // Add !

      // Trigger iterator error
      await act(async () => { mockIteratorController.error(mockIteratorError); });

      await waitFor(() => {
          expect(getLatestState()!.status).toBe('error');
      });

      const errorState = getLatestState()!; // Add !
      expect(errorState.error).toEqual(mockIteratorError); // Hook should store the raw error
      // Callback receives a structured error message
      expect(onErrorMock).toHaveBeenCalledWith({ message: `Subscription failed: ${mockIteratorError.message}` });
    });

    it('should handle errors during store update (applyServerDelta)', async () => {
      const onErrorMock = vi.fn();
      const storeError = new Error("Store update failed");
      applyServerDeltaMock.mockImplementationOnce(() => { throw storeError; });

      const { getLatestState } = renderSubscriptionHook({
          procedure: mockSubscriptionProcedure,
          input: mockInput,
          options: { onError: onErrorMock }
      });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting')); // Add !

      // Push data that will cause store error
      // Push data within act
      await act(async () => { mockIteratorController.push(mockData1); });

      // Wait specifically for the error status and error object caused by applyServerDeltaMock
      await waitFor(() => {
          const latestState = getLatestState()!;
          expect(latestState.status).toBe('error');
          expect(latestState.error).toEqual(storeError);
      });

      const errorState = getLatestState()!; // Re-fetch state after waiting
      expect(errorState.error).toEqual(storeError); // Hook stores the raw store error
      expect(onErrorMock).toHaveBeenCalledWith({ message: `Store error: ${storeError.message}` });
      expect(applyServerDeltaMock).toHaveBeenCalledWith(mockData1);
    });

    it('should transition to ended state when iterator completes', async () => {
      const onEndMock = vi.fn();
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { onEnd: onEndMock } });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting')); // Add !
      await act(async () => { mockIteratorController.push(mockData1); }); // Ensure it becomes active first
      await waitFor(() => expect(getLatestState()!.status).toBe('active')); // Add !

      // End the iterator
      await act(async () => { mockIteratorController.end(); });

      await waitFor(() => {
          expect(getLatestState()!.status).toBe('ended');
      });
      expect(onEndMock).toHaveBeenCalled();
    });

    it('should call unsubscribe when the component unmounts', async () => {
      const { unmount } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput });
      // Wait for subscription to potentially establish and set unsubscribeFn
      await waitFor(() => expect(mockSubscriptionProcedure.subscribe).toHaveBeenCalled());
      expect(mockUnsubscribeFn).toBeDefined(); // Ensure unsubscribe mock was created
      expect(mockUnsubscribeFn).not.toHaveBeenCalled();
      unmount();
      expect(mockUnsubscribeFn).toHaveBeenCalled();
    });

     it('should call unsubscribe manually and transition to idle', async () => {
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput });

      // Wait for unsubscribe function to be available in state
      await waitFor(() => {
          expect(getLatestState()?.unsubscribe).toBeInstanceOf(Function);
      });
      const stateWithUnsub = getLatestState()!; // Add !
      expect(mockUnsubscribeFn).toBeDefined();
      expect(mockUnsubscribeFn).not.toHaveBeenCalled();

      // Call manual unsubscribe
      // Wrap the unsubscribe call in act as it triggers state updates
      act(() => { stateWithUnsub.unsubscribe?.(); });

      expect(mockUnsubscribeFn).toHaveBeenCalled();
      // Wait specifically for the idle status
      await waitFor(() => {
          expect(getLatestState()!.status).toBe('idle');
      });
    });

    it('should be in idle state if enabled is false', async () => { // Add async
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { enabled: false } });
      expect(mockSubscriptionProcedure.subscribe).not.toHaveBeenCalled();
      // Need to wait briefly for initial state capture if using useEffect for state reporting
      await waitFor(() => expect(getLatestState()).toBeDefined()); // Add await
      expect(getLatestState()!.status).toBe('idle'); // Add !
    });

}); // End of useSubscription describe