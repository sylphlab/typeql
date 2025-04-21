import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/preact';
import { h } from 'preact';
import { signal } from '@preact/signals-core';
import { zenQueryProvider } from '../context';
import { useSubscription } from './useSubscription';
import type { createClient } from '@sylphlab/zen-query-client';
import type { zenQueryClientError } from '@sylphlab/zen-query-shared'; // Import error from shared
// Use ReturnType to get the type of the client instance for mocking
type zenQueryClientInstance = ReturnType<typeof createClient>;
import type {
  SubscribeMessage,
  SubscriptionDataMessage,
  SubscriptionErrorMessage,
  UnsubscribeFn,
} from '@sylphlab/zen-query-shared';

// --- Mock Async Iterator Setup ---
// Helper to create a controllable async iterator
function createMockAsyncIterator<T>() {
  // Add explicit type annotation for the queue array
  type QueueItem<T> = { type: 'yield'; value: T } | { type: 'error'; error: any } | { type: 'return' };
  const queue: QueueItem<T>[] = []; // Explicit type annotation
  let resolveNext: ((value: IteratorResult<T>) => void) | null = null;
  let rejectNext: ((reason?: any) => void) | null = null;
  let isDone = false;

  const next = (): Promise<IteratorResult<T>> => {
    return new Promise((resolve, reject) => {
      const nextItem = queue.shift();
      if (nextItem) {
        if (nextItem.type === 'yield') {
          resolve({ value: nextItem.value, done: false });
        } else if (nextItem.type === 'error') {
          reject(nextItem.error);
          isDone = true; // Assume iterator stops on error
        } else { // 'return'
          resolve({ value: undefined, done: true });
          isDone = true;
        }
      } else if (isDone) {
         resolve({ value: undefined, done: true });
      }
       else {
        // Wait for next push
        resolveNext = resolve;
        rejectNext = reject;
      }
    });
  };

  const push = (value: T) => {
    if (isDone) return;
    if (resolveNext) {
      resolveNext({ value, done: false });
      resolveNext = null;
      rejectNext = null;
    } else {
      queue.push({ type: 'yield', value });
    }
  };

  const error = (err: any) => {
     if (isDone) return;
     isDone = true;
     if (rejectNext) {
       rejectNext(err);
       resolveNext = null;
       rejectNext = null;
     } else {
       queue.push({ type: 'error', error: err });
     }
  };

  const complete = () => {
     if (isDone) return;
     isDone = true;
     if (resolveNext) {
       resolveNext({ value: undefined, done: true });
       resolveNext = null;
       rejectNext = null;
     } else {
       queue.push({ type: 'return' });
     }
  };

  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]: () => iterator,
    next,
    // Optional: Add return/throw if needed for more complex scenarios
    // return: async () => { complete(); return { value: undefined, done: true }; },
    // throw: async (err) => { error(err); throw err; },
  };

  return { iterator, push, error, complete };
}
// --- End Mock Async Iterator Setup ---


// Mock client
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockQuery = vi.fn(); // Add mocks for other methods
const mockMutation = vi.fn();
const mockGetCoordinator = vi.fn(() => ({ on: vi.fn(), getPendingPatches: vi.fn(() => new Map()) })); // Basic coordinator mock

const mockClient: zenQueryClientInstance = {
  query: { // Mock query structure
      // Add specific procedures if needed
  } as any,
  mutation: { // Mock mutation structure
      // Add specific procedures if needed
  } as any,
  subscribe: mockSubscribe, // Keep existing mock for this test file
  getCoordinator: mockGetCoordinator,
  close: vi.fn(),
};

// Wrapper component providing the context
// Use JSX for wrapper
const wrapper = ({ children }: { children: any }) => (
  <zenQueryProvider client={mockClient}>{children}</zenQueryProvider>
);

describe('useSubscription', () => {
  let mockIteratorControls: ReturnType<typeof createMockAsyncIterator<SubscriptionDataMessage | SubscriptionErrorMessage>>;

  beforeEach(() => {
    // Reset mocks
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
    // Setup default mock return value for subscribe
    mockIteratorControls = createMockAsyncIterator();
    mockSubscribe.mockReturnValue({
      iterator: mockIteratorControls.iterator,
      unsubscribe: mockUnsubscribe,
    });
  });

  it('should initialize with idle state and undefined data/error', () => {
    const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
    const { result } = renderHook(() => useSubscription(mockProcedure, { topic: 'test' }, { enabled: false }), { wrapper });

    expect(result.current.status.value).toBe('idle');
    expect(result.current.data.value).toBeUndefined();
    expect(result.current.error.value).toBeNull();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('should transition status to connecting then connected when enabled', async () => {
    const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
    const { result } = renderHook(() => useSubscription(mockProcedure, { topic: 'test' }), { wrapper });

    // Check that subscribe was called, implying connection attempt started
    expect(mockSubscribe).toHaveBeenCalledOnce();

    // Wait for status to become 'connected' as the transition might be synchronous
    await waitFor(() => {
      expect(result.current.status.value).toBe('connected');
    });
  });

  it('should update data signal and call onData when iterator yields data', async () => {
    const onDataMock = vi.fn();
    const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
    const { result } = renderHook(() => useSubscription(mockProcedure, { topic: 'data' }, { onData: onDataMock }), { wrapper });

    await waitFor(() => expect(result.current.status.value).toBe('connected'));

    const dataMessage: SubscriptionDataMessage = { id: 1, type: 'subscriptionData', data: { value: 1 }, serverSeq: 1 };

    // Push data to the mock iterator
    act(() => {
        mockIteratorControls.push(dataMessage);
    });


    // Wait for signal update
    await waitFor(() => {
      expect(result.current.data.value).toEqual({ value: 1 });
    });
    expect(result.current.error.value).toBeNull();
    expect(onDataMock).toHaveBeenCalledOnce();
    expect(onDataMock).toHaveBeenCalledWith({ value: 1 });
  });

  it('should update error signal and call onError when iterator yields error', async () => {
    const onErrorMock = vi.fn();
    const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
    const { result } = renderHook(() => useSubscription(mockProcedure, { topic: 'error' }, { onError: onErrorMock }), { wrapper });

    await waitFor(() => expect(result.current.status.value).toBe('connected'));

    const errorMessage: SubscriptionErrorMessage = { id: 1, type: 'subscriptionError', error: { message: 'Sub Failed', code: 'SUB_ERROR' } };

    // Push error to the mock iterator
     act(() => {
        mockIteratorControls.push(errorMessage); // Push error message
     });


    // Wait for status and error signal update
    await waitFor(() => {
      expect(result.current.status.value).toBe('error');
    });
    expect(result.current.error.value).toEqual(errorMessage.error);
    expect(result.current.data.value).toBeUndefined(); // Or should it keep last data? Undefined for now.
    expect(onErrorMock).toHaveBeenCalledOnce();
    expect(onErrorMock).toHaveBeenCalledWith(errorMessage.error);
  });

   it('should update status and call onEnded when iterator completes normally', async () => {
       const onEndedMock = vi.fn();
       const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
       const { result } = renderHook(() => useSubscription(mockProcedure, { topic: 'end' }, { onEnded: onEndedMock }), { wrapper });

       await waitFor(() => expect(result.current.status.value).toBe('connected'));

       // Complete the iterator
       act(() => {
           mockIteratorControls.complete();
       });


       // Wait for status update
       await waitFor(() => {
           expect(result.current.status.value).toBe('ended');
       });
       expect(result.current.error.value).toBeNull();
       expect(onEndedMock).toHaveBeenCalledOnce();
   });


  it('should call unsubscribe on unmount', async () => {
    const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
    const { unmount, result } = renderHook(() => useSubscription(mockProcedure, { topic: 'cleanup' }), { wrapper });

    await waitFor(() => expect(result.current.status.value).toBe('connected')); // Ensure subscription started

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalledOnce();
  });

  it('should not subscribe if enabled is false initially', () => {
     const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
     renderHook(() => useSubscription(mockProcedure, { topic: 'disabled' }, { enabled: false }), { wrapper });
     expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('should subscribe when enabled becomes true', async () => {
      const enabledSignal = signal(false);
      const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
      const { result, rerender } = renderHook(
          (props) => useSubscription(mockProcedure, { topic: 'toggle' }, { enabled: props.enabled }),
          { wrapper, initialProps: { enabled: enabledSignal.value } }
      );

      expect(mockSubscribe).not.toHaveBeenCalled();

      act(() => {
          enabledSignal.value = true;
      });
      rerender({ enabled: enabledSignal.value });


      await waitFor(() => expect(mockSubscribe).toHaveBeenCalledOnce());
      // Need to access result within waitFor to get latest state
      await waitFor(() => expect(result.current.status.value).toBe('connected'));
  });

   it('should unsubscribe when enabled becomes false', async () => {
       const enabledSignal = signal(true);
       const mockProcedure = (input: { topic: string }) => mockSubscribe({ path: 'updates', input }); // Use direct mock
       const { result, rerender } = renderHook(
           (props) => useSubscription(mockProcedure, { topic: 'toggle-off' }, { enabled: props.enabled }),
           { wrapper, initialProps: { enabled: enabledSignal.value } }
       );

       await waitFor(() => expect(result.current.status.value).toBe('connected'));
       expect(mockUnsubscribe).not.toHaveBeenCalled();

       act(() => {
           enabledSignal.value = false;
       });
       rerender({ enabled: enabledSignal.value });


       // Status should become idle, unsubscribe called
       await waitFor(() => expect(result.current.status.value).toBe('idle'));
       expect(mockUnsubscribe).toHaveBeenCalledOnce();
   });

});
