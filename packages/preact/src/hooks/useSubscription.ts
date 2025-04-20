import { useEffect, useMemo } from 'preact/hooks';
import { signal, Signal } from '@preact/signals-core';
import { useTypeQL } from '../context';
import type {
  TypeQLClientError,
  SubscribeMessage, // Type for input to client.subscribe
  SubscriptionDataMessage,
  SubscriptionErrorMessage,
  UnsubscribeFn,
} from '@sylphlab/typeql-shared'; // Assuming shared types export

// Define subscription status types
export type SubscriptionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'ended';

// Define options for the useSubscription hook
export interface UseSubscriptionOptions<TData = unknown, TError = TypeQLClientError> {
  /** If false, the subscription will not execute automatically. Defaults to true. */
  enabled?: boolean;
  /** Callback function invoked when new data is received. */
  onData?: (data: TData) => void;
  /** Callback function invoked when an error occurs. */
  onError?: (error: TError) => void;
  /** Callback function invoked when the subscription ends normally. */
  onEnded?: () => void;
}

// Define the return type of the useSubscription hook
export interface UseSubscriptionResult<TData = unknown, TError = TypeQLClientError> {
  data: Signal<TData | undefined>;
  error: Signal<TError | null>;
  status: Signal<SubscriptionStatus>;
  // unsubscribe?: UnsubscribeFn; // Maybe expose unsubscribe? For now, handled by effect cleanup.
}

/**
 * Hook for managing TypeQL subscriptions.
 *
 * @param subscriptionProcedure The client subscription procedure (e.g., client.post.onUpdate.subscribe)
 * @param input Input parameters for the subscription procedure.
 * @param options Configuration options for the subscription.
 */
export function useSubscription<TInput, TOutput>(
  // Procedure type needs careful handling. Using a function type for now.
  subscriptionProcedure: (input: TInput) => { iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>; unsubscribe: UnsubscribeFn },
  input: TInput,
  options: UseSubscriptionOptions<TOutput> = {},
): UseSubscriptionResult<TOutput> {
  const { client } = useTypeQL(); // Get client from context
  const { enabled = true, onData, onError, onEnded } = options;

  // --- State Signals ---
  const dataSignal = signal<TOutput | undefined>(undefined);
  const errorSignal = signal<TypeQLClientError | null>(null);
  const statusSignal = signal<SubscriptionStatus>('idle');

  // --- Input Memoization ---
  // Reusing the same memoization strategy as useQuery
  const stableInputKey = useMemo(() => {
    try {
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const sortedInput = Object.keys(input as object)
          .sort()
          .reduce((acc, key) => {
            acc[key as keyof TInput] = (input as any)[key];
            return acc;
          }, {} as TInput);
        return JSON.stringify(sortedInput);
      }
      return JSON.stringify(input);
    } catch (e) {
      console.error("Failed to stringify subscription input for memoization:", input, e);
      return String(Date.now());
    }
  }, [input]);

  // --- Effect for Subscription Lifecycle ---
  useEffect(() => {
    if (!enabled) {
      statusSignal.value = 'idle';
      return; // Don't subscribe if not enabled
    }

    let unsubscribeFn: UnsubscribeFn | null = null;
    let isCancelled = false; // Prevent updates after cleanup

    const runSubscription = async () => {
      statusSignal.value = 'connecting';
      errorSignal.value = null; // Clear previous error

      try {
        const { iterator, unsubscribe } = subscriptionProcedure(input);
        unsubscribeFn = unsubscribe; // Store unsubscribe function for cleanup

        if (isCancelled) {
          unsubscribeFn?.(); // Unsubscribe immediately if cancelled before connection
          return;
        }

        statusSignal.value = 'connected';

        // Consume the async iterator
        for await (const message of iterator) {
          if (isCancelled) break; // Exit loop if cancelled

          if (message.type === 'subscriptionData') {
            // Assuming message.data is of type TOutput
            const newData = message.data as TOutput;
            dataSignal.value = newData;
            onData?.(newData);
          } else if (message.type === 'subscriptionError') {
            // Assuming message.error structure matches TypeQLClientError or can be cast
            const error = message.error as TypeQLClientError;
            errorSignal.value = error;
            statusSignal.value = 'error';
            onError?.(error);
            // Should the loop break on error? Depends on desired behavior. Breaking for now.
            break;
          }
          // Note: SubscriptionEndMessage is implicitly handled by iterator completion
        }

        // If loop finishes without break/cancellation, it ended normally
        if (!isCancelled && statusSignal.peek() !== 'error') {
           statusSignal.value = 'ended';
           onEnded?.();
        }

      } catch (err: unknown) {
        console.error('useSubscription failed:', err);
        if (!isCancelled) {
          const error = (err instanceof Error ? err : new Error(String(err))) as TypeQLClientError; // Basic casting
          errorSignal.value = error;
          statusSignal.value = 'error';
          onError?.(error);
        }
      } finally {
         // Ensure status isn't left as 'connecting' if an initial error occurred
         if (!isCancelled && statusSignal.peek() === 'connecting') {
             statusSignal.value = 'error'; // Or 'idle'? 'error' seems more informative
         }
      }
    };

    runSubscription();

    // Cleanup function
    return () => {
      isCancelled = true;
      if (unsubscribeFn) {
        console.log('Unsubscribing...');
        unsubscribeFn();
      }
      // Reset state on cleanup? Optional, depends on desired behavior on re-mount/disable.
      // statusSignal.value = 'idle';
      // dataSignal.value = undefined;
      // errorSignal.value = null;
    };
  }, [stableInputKey, enabled, subscriptionProcedure, onData, onError, onEnded]); // Include callbacks in dependencies

  return {
    data: dataSignal,
    error: errorSignal,
    status: statusSignal,
  };
}
