import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { usezenQuery } from '../context';
import type {
  zenQueryClientError,
  SubscribeMessage, // Type for input to client.subscribe
  SubscriptionDataMessage,
  SubscriptionErrorMessage,
  UnsubscribeFn,
} from '@sylphlab/zen-query-shared'; // Assuming shared types export

// Define subscription status types
export type SubscriptionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'ended';

// Define options for the useSubscription hook
export interface UseSubscriptionOptions<TData = unknown, TError = zenQueryClientError> {
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
export interface UseSubscriptionResult<TData = unknown, TError = zenQueryClientError> {
  data: TData | undefined;
  error: TError | null;
  status: SubscriptionStatus;
  // unsubscribe?: UnsubscribeFn; // Maybe expose unsubscribe? For now, handled by effect cleanup.
}

/**
 * Hook for managing zenQuery subscriptions.
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
  const { client } = usezenQuery(); // Get client from context
  const { enabled = true, onData, onError, onEnded } = options;

  // --- State using useState ---
  const [data, setData] = useState<TOutput | undefined>(undefined);
  const [error, setError] = useState<zenQueryClientError | null>(null);
  const [status, setStatus] = useState<SubscriptionStatus>('idle');

  // Ref to track mounted state
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Ref to store the unsubscribe function
  const unsubscribeRef = useRef<UnsubscribeFn | null>(null);

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
      // console.error("Failed to stringify subscription input for memoization:", input, e); // Removed log
      return String(Date.now());
    }
  }, [input]);

  // --- Effect for Subscription Lifecycle ---
  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      // Ensure cleanup happens if disabled while active
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      return; // Don't subscribe if not enabled
    }

    let isEffectCancelled = false; // Specific flag for this effect execution instance

    const runSubscription = async () => {
      if (!mountedRef.current) return; // Check mount status at start
      let errorOccurred = false; // Flag to track if an error happened in the loop
      setStatus('connecting');
      setError(null); // Clear previous error

      try {
        const { iterator, unsubscribe } = subscriptionProcedure(input);
        unsubscribeRef.current = unsubscribe; // Store unsubscribe function

        if (isEffectCancelled || !mountedRef.current) {
          unsubscribeRef.current?.(); // Unsubscribe immediately if cancelled/unmounted
          unsubscribeRef.current = null;
          return;
        }

        setStatus('connected');

        // Consume the async iterator
        for await (const message of iterator) {
          if (isEffectCancelled || !mountedRef.current) break; // Exit loop if cancelled/unmounted

          if (message.type === 'subscriptionData') {
            const newData = message.data as TOutput;
            setData(newData);
            onData?.(newData);
          } else if (message.type === 'subscriptionError') {
            const error = message.error as zenQueryClientError;
            errorOccurred = true; // Set the flag
            setError(error);
            setStatus('error');
            onError?.(error);
            break; // Stop processing on error
          }
        }

        // If loop finishes without break/cancellation/unmount AND no error occurred, it ended normally
        if (!isEffectCancelled && mountedRef.current && !errorOccurred) {
           setStatus('ended');
           onEnded?.();
        }

      } catch (err: unknown) {
        // console.error('useSubscription failed:', err); // Removed log
        errorOccurred = true; // Set flag if initial connection/iteration fails
        if (!isEffectCancelled && mountedRef.current) {
          const error = (err instanceof Error ? err : new Error(String(err))) as zenQueryClientError; // Basic casting
          setError(error);
          setStatus('error');
          onError?.(error);
        }
      } finally {
         // Ensure status isn't left as 'connecting' if an initial error occurred
         if (!isEffectCancelled && mountedRef.current && status === 'connecting') {
             setStatus('error'); // Or 'idle'? 'error' seems more informative
         }
      }
    };

    runSubscription();

    // Cleanup function for the effect
    return () => {
      isEffectCancelled = true;
      if (unsubscribeRef.current) {
        // console.log('Unsubscribing...'); // Removed log
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      // Optionally reset state on cleanup?
      // setStatus('idle');
      // setData(undefined);
      // setError(null);
    };
    // Use stableInputKey, enabled, and the procedure itself.
    // Callbacks are included to re-subscribe if they change.
  }, [stableInputKey, enabled, subscriptionProcedure, onData, onError, onEnded]);

  return {
    data,
    error,
    status,
  };
}