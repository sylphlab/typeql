import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react'; // Use React Testing Library
import React, { type ReactNode } from 'react'; // Import React
// Removed signal import
import { zenQueryProvider } from '../context'; // Import React context
import { useSubscription } from '../hooks/useSubscription'; // Import React hook
import type { createClient, zenQueryClientError } from '@sylphlab/zen-query-client'; // Import createClient for ReturnType
import type {
  SubscribeMessage,
  SubscriptionDataMessage,
  SubscriptionErrorMessage,
  UnsubscribeFn,
} from '@sylphlab/zen-query-shared';

// Use ReturnType to get the actual client type
type zenQueryClientInstance = ReturnType<typeof createClient>;

// --- Mock Async Iterator Setup (Same as Preact test) ---
function createMockAsyncIterator<T>() {
  type QueueItem<T> = { type: 'yield'; value: T } | { type: 'error'; error: any } | { type: 'return' };
  const queue: QueueItem<T>[] = [];
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
          isDone = true;
        } else { // 'return'
          resolve({ value: undefined, done: true });
          isDone = true;
        }
      } else if (isDone) {
         resolve({ value: undefined, done: true });
      } else {
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
  };

  return { iterator, push, error, complete };
}
// --- End Mock Async Iterator Setup ---


// Mock client
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockClient = {
  subscribe: mockSubscribe,
} as unknown as zenQueryClientInstance;

// Wrapper component providing the context (using React JSX)
const wrapper = ({ children }: { children: ReactNode }) => ( // Use ReactNode
  <zenQueryProvider client={mockClient}>{children}</zenQueryProvider>
);

describe('useSubscription (React)', () => {
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
    // Pass the mock function directly
    const { result } = renderHook(() => useSubscription(mockSubscribe, { topic: 'test' }, { enabled: false }), { wrapper });

    // Access state directly
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('should transition status to connecting then connected when enabled', async () => {
    // Pass the mock function directly
    const { result } = renderHook(() => useSubscription(mockSubscribe, { topic: 'test' }), { wrapper });

    expect(mockSubscribe).toHaveBeenCalledOnce();

    // Status might briefly be 'connecting' before 'connected'
    await waitFor(() => {
      expect(result.current.status).toBe('connected');
    });
  });

  it('should update data and call onData when iterator yields data', async () => {
    const onDataMock = vi.fn();
    // Pass the mock function directly
    const { result } = renderHook(() => useSubscription(mockSubscribe, { topic: 'data' }, { onData: onDataMock }), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('connected'));

    const dataMessage: SubscriptionDataMessage = { id: 1, type: 'subscriptionData', data: { value: 1 }, serverSeq: 1 };

    // Push data to the mock iterator
    act(() => {
        mockIteratorControls.push(dataMessage);
    });


    // Wait for state update
    await waitFor(() => {
      expect(result.current.data).toEqual({ value: 1 });
    });
    expect(result.current.error).toBeNull();
    expect(onDataMock).toHaveBeenCalledOnce();
    expect(onDataMock).toHaveBeenCalledWith({ value: 1 });
  });

  it('should update error and call onError when iterator yields error', async () => {
    const onErrorMock = vi.fn();
    // Pass the mock function directly
    const { result } = renderHook(() => useSubscription(mockSubscribe, { topic: 'error' }, { onError: onErrorMock }), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('connected'));

    const errorMessage: SubscriptionErrorMessage = { id: 1, type: 'subscriptionError', error: { message: 'Sub Failed', code: 'SUB_ERROR' } };

    // Push error to the mock iterator
     act(() => {
        mockIteratorControls.push(errorMessage); // Push error message
     });


    // Wait for status and error state update
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error).toEqual(errorMessage.error);
    expect(result.current.data).toBeUndefined(); // Or should it keep last data? Undefined for now.
    expect(onErrorMock).toHaveBeenCalledOnce();
    expect(onErrorMock).toHaveBeenCalledWith(errorMessage.error);
  });

   it('should update status and call onEnded when iterator completes normally', async () => {
       const onEndedMock = vi.fn();
       // Pass the mock function directly
       const { result } = renderHook(() => useSubscription(mockSubscribe, { topic: 'end' }, { onEnded: onEndedMock }), { wrapper });

       await waitFor(() => expect(result.current.status).toBe('connected'));

       // Complete the iterator
       act(() => {
           mockIteratorControls.complete();
       });


       // Wait for status update
       await waitFor(() => {
           expect(result.current.status).toBe('ended');
       });
       expect(result.current.error).toBeNull();
       expect(onEndedMock).toHaveBeenCalledOnce();
   });


  it('should call unsubscribe on unmount', async () => {
    // Pass the mock function directly
    const { unmount, result } = renderHook(() => useSubscription(mockSubscribe, { topic: 'cleanup' }), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('connected')); // Ensure subscription started

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalledOnce();
  });

  it('should not subscribe if enabled is false initially', () => {
     // Pass the mock function directly
     renderHook(() => useSubscription(mockSubscribe, { topic: 'disabled' }, { enabled: false }), { wrapper });
     expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('should subscribe when enabled becomes true', async () => {
      let currentEnabled = false; // Use simple variable
      // Pass the mock function directly
      const { result, rerender } = renderHook(
          (props) => useSubscription(mockSubscribe, { topic: 'toggle' }, { enabled: props.enabled }),
          { wrapper, initialProps: { enabled: currentEnabled } }
      );

      expect(mockSubscribe).not.toHaveBeenCalled();

      // Enable via rerender
      currentEnabled = true;
      rerender({ enabled: currentEnabled });


      await waitFor(() => expect(mockSubscribe).toHaveBeenCalledOnce());
      // Need to access result within waitFor to get latest state
      await waitFor(() => expect(result.current.status).toBe('connected'));
  });

   it('should unsubscribe when enabled becomes false', async () => {
       let currentEnabled = true; // Use simple variable
       // Pass the mock function directly
       const { result, rerender } = renderHook(
           (props) => useSubscription(mockSubscribe, { topic: 'toggle-off' }, { enabled: props.enabled }),
           { wrapper, initialProps: { enabled: currentEnabled } }
       );

       await waitFor(() => expect(result.current.status).toBe('connected'));
       expect(mockUnsubscribe).not.toHaveBeenCalled();

       // Disable via rerender
       currentEnabled = false;
       rerender({ enabled: currentEnabled });


       // Status should become idle, unsubscribe called
       await waitFor(() => expect(result.current.status).toBe('idle'));
       expect(mockUnsubscribe).toHaveBeenCalledOnce();
   });

});