{/* packages/react/src/hooks/useSubscription.test.tsx */}
import React, { ReactNode } from 'react'; // Import ReactNode
import { describe, it, expect, vi, beforeEach, afterEach, Mock, afterAll } from 'vitest';
import { render, renderHook, act, waitFor, cleanup } from '@testing-library/react'; // Import renderHook
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
    let mockUnsubscribeFn: Mock<() => void>;

    const mockSubscriptionProcedure = {
      subscribe: vi.fn((_input: any) => {
        const buffer: (SubscriptionDataMessage | SubscriptionErrorMessage)[] = [];
        let resolveNext: ((value: IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>) => void) | null = null;
        let rejectNext: ((reason?: any) => void) | null = null;
        let ended = false;

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
                    buffer.push({ type: 'subscriptionError', id: 'ctrl-error-id', error: { message: err.message } });
                }
            }
        };

        const iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> = {
            async next() {
                if (buffer.length > 0) {
                    const value = buffer.shift()!;
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

        mockUnsubscribeFn = vi.fn(() => {
            mockIteratorController?.end();
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
      mockUnsubscribeFn?.mockClear();
    });

    afterEach(() => {
        cleanup();
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

    it('should initially be in connecting state when enabled', async () => {
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput });
      await waitFor(() => expect(getLatestState()).toBeDefined());
      const initialState = getLatestState()!;
      expect(initialState.status).toBe('connecting');
      expect(initialState.data).toBeNull();
      expect(initialState.error).toBeNull();
      expect(mockSubscriptionProcedure.subscribe).toHaveBeenCalledWith(mockInput);
    });

    it('should transition to active state and receive data, calling onData and applyServerDelta', async () => {
      const onDataMock = vi.fn();
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { onData: onDataMock } });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting'));

      await act(async () => { mockIteratorController.push(mockData1); });

      await waitFor(() => {
          expect(getLatestState()!.status).toBe('active');
          expect(getLatestState()!.data).toEqual(mockData1.data);
      });

      const activeState1 = getLatestState()!;
      expect(activeState1.error).toBeNull();
      expect(onDataMock).toHaveBeenCalledWith(mockData1.data);
      expect(applyServerDeltaMock).toHaveBeenCalledWith(mockData1);

      await act(async () => { mockIteratorController.push(mockData2); });

      await waitFor(() => {
          expect(getLatestState()!.data).toEqual(mockData2.data);
      });

      const activeState2 = getLatestState()!;
      expect(activeState2.status).toBe('active');
      expect(activeState2.error).toBeNull();
      expect(onDataMock).toHaveBeenCalledWith(mockData2.data);
      expect(applyServerDeltaMock).toHaveBeenCalledWith(mockData2);
    });

    it('should handle input serialization error and warn', () => {
        const circularInput: any = { id: 1 };
        circularInput.self = circularInput;
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        renderSubscriptionHook({
            procedure: mockSubscriptionProcedure,
            input: circularInput
        });

        expect(consoleWarnSpy).toHaveBeenCalledWith(
            "useSubscription: Failed to stringify input for dependency key. Updates may be missed for complex objects."
        );
        consoleWarnSpy.mockRestore();
    });

    it('should handle subscription error messages from iterator', async () => {
      const onErrorMock = vi.fn();
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { onError: onErrorMock } });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting'));

      await act(async () => { mockIteratorController.push(mockSubErrorMsg); });

      await waitFor(() => {
          const latestState = getLatestState()!;
          expect(latestState.status).toBe('error');
          expect(latestState.error).toBeInstanceOf(TypeQLClientError);
          expect(latestState.error?.message).toBe(mockSubErrorMsg.error.message);
      });

      const errorState = getLatestState()!;
      expect(errorState.error).toBeInstanceOf(TypeQLClientError);
      expect(errorState.error?.message).toBe(mockSubErrorMsg.error.message);
      expect(onErrorMock).toHaveBeenCalledWith(mockSubErrorMsg.error);
    });

     it('should handle iterator errors (e.g., network failure)', async () => {
      const onErrorMock = vi.fn();
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { onError: onErrorMock } });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting'));

      await act(async () => { mockIteratorController.error(mockIteratorError); });

      await waitFor(() => {
          expect(getLatestState()!.status).toBe('error');
      });

      const errorState = getLatestState()!;
      expect(errorState.error).toEqual(mockIteratorError);
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

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting'));

      await act(async () => { mockIteratorController.push(mockData1); });

      await waitFor(() => {
          const latestState = getLatestState()!;
          expect(latestState.status).toBe('error');
          expect(latestState.error).toEqual(storeError);
      });

      const errorState = getLatestState()!;
      expect(errorState.error).toEqual(storeError);
      expect(onErrorMock).toHaveBeenCalledWith({ message: `Store error: ${storeError.message}` });
      expect(applyServerDeltaMock).toHaveBeenCalledWith(mockData1);
    });

    it('should transition to ended state when iterator completes', async () => {
      const onEndMock = vi.fn();
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { onEnd: onEndMock } });

      await waitFor(() => expect(getLatestState()!.status).toBe('connecting'));
      await act(async () => { mockIteratorController.push(mockData1); });
      await waitFor(() => expect(getLatestState()!.status).toBe('active'));

      await act(async () => { mockIteratorController.end(); });

      await waitFor(() => {
          expect(getLatestState()!.status).toBe('ended');
      });
      expect(onEndMock).toHaveBeenCalled();
    });

    it('should call unsubscribe when the component unmounts', async () => {
      const { unmount } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput });
      await waitFor(() => expect(mockSubscriptionProcedure.subscribe).toHaveBeenCalled());
      expect(mockUnsubscribeFn).toBeDefined();
      expect(mockUnsubscribeFn).not.toHaveBeenCalled();
      unmount();
      expect(mockUnsubscribeFn).toHaveBeenCalled();
    });

     it('should call unsubscribe manually and transition to idle', async () => {
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput });

      await waitFor(() => {
          expect(getLatestState()?.unsubscribe).toBeInstanceOf(Function);
      });
      const stateWithUnsub = getLatestState()!;
      expect(mockUnsubscribeFn).toBeDefined();
      expect(mockUnsubscribeFn).not.toHaveBeenCalled();

      act(() => { stateWithUnsub.unsubscribe?.(); });

      expect(mockUnsubscribeFn).toHaveBeenCalled();
      await waitFor(() => {
          expect(getLatestState()!.status).toBe('idle');
      });
    });

    it('should be in idle state if enabled is false', async () => {
      const { getLatestState } = renderSubscriptionHook({ procedure: mockSubscriptionProcedure, input: mockInput, options: { enabled: false } });
      expect(mockSubscriptionProcedure.subscribe).not.toHaveBeenCalled();
      await waitFor(() => expect(getLatestState()).toBeDefined());
      expect(getLatestState()!.status).toBe('idle');
    });

    it('should unsubscribe and reset state when disabled', async () => {
      const { getLatestState, rerender } = renderSubscriptionHook({
        procedure: mockSubscriptionProcedure,
        input: mockInput,
        options: { enabled: true }
      });

      await waitFor(() => {
        expect(getLatestState()?.unsubscribe).toBeInstanceOf(Function);
        expect(mockSubscriptionProcedure.subscribe).toHaveBeenCalled();
      });
      expect(mockUnsubscribeFn).not.toHaveBeenCalled();

      // Need a state capture function for rerender
      const stateChanges: UseSubscriptionResult<any>[] = [];
      const onStateChange = (state: UseSubscriptionResult<any>) => stateChanges.push(state);
      const getRerenderLatestState = () => stateChanges[stateChanges.length - 1];

      rerender(
        <TypeQLProvider client={{ ...mockClient, testSub: mockSubscriptionProcedure } as any} store={mockStore}>
          <SubscriptionViewer
            procedure={mockSubscriptionProcedure}
            input={mockInput}
            options={{ enabled: false }} // Disable here
            onStateChange={onStateChange} // Use the new state capture
          />
        </TypeQLProvider>
      );

      await waitFor(() => {
        // Use the state capture from the rerender
        expect(getRerenderLatestState()?.status).toBe('idle');
      });
      expect(mockUnsubscribeFn).toHaveBeenCalled();
      // Check state from the rerender's capture
      expect(getRerenderLatestState()?.data).toBeNull();
      expect(getRerenderLatestState()?.error).toBeNull();
    });

    it('should call onData but not applyServerDelta when no store is provided', async () => {
      const onDataMock = vi.fn();

      // Custom render helper for this test to provide undefined store
      const stateChanges: UseSubscriptionResult<any>[] = [];
      const onStateChange = (state: UseSubscriptionResult<any>) => stateChanges.push(state);
      render(
           <TypeQLProvider client={{ ...mockClient, testSub: mockSubscriptionProcedure } as any} store={undefined}> {/* Store is undefined */}
               <SubscriptionViewer
                 procedure={mockSubscriptionProcedure}
                 input={mockInput}
                 options={{ onData: onDataMock }}
                 onStateChange={onStateChange}
               />
           </TypeQLProvider>
      );
      const getLatestState = () => stateChanges[stateChanges.length - 1];

      await waitFor(() => expect(getLatestState()?.status).toBe('connecting'));

      // Push data
      await act(async () => { mockIteratorController.push(mockData1); });

      // Wait for state transition and data processing
      await waitFor(() => {
          expect(getLatestState()?.status).toBe('active');
          expect(getLatestState()?.data).toEqual(mockData1.data);
      });

      expect(onDataMock).toHaveBeenCalledWith(mockData1.data);
      expect(applyServerDeltaMock).not.toHaveBeenCalled(); // Crucial check
    });

}); // End of useSubscription describe