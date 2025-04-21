import { useEffect, useMemo } from 'preact/hooks';
import { signal, Signal, computed } from '@preact/signals-core';
import { usezenQuery } from '../context';
import type { zenQueryClientError } from '@sylphlab/zen-query-client'; // Assuming error type export

// Define options for the useQuery hook
export interface UseQueryOptions {
  /** If false, the query will not execute automatically. Defaults to true. */
  enabled?: boolean;
  // TODO: Add other options like staleTime, cacheTime, refetchOnWindowFocus etc. later
}

// Define the return type of the useQuery hook
export interface UseQueryResult<TData = unknown, TError = zenQueryClientError> {
  data: Signal<TData | undefined>;
  error: Signal<TError | null>;
  isFetching: Signal<boolean>;
  // isSuccess: Signal<boolean>; // Can be computed
  // isError: Signal<boolean>; // Can be computed
  // refetch: () => Promise<void>; // TODO: Add manual refetch capability
}

/**
 * Hook for fetching data using a zenQuery query.
 *
 * @param queryProcedure The client query procedure (e.g., client.post.get)
 * @param input Input parameters for the query procedure.
 * @param options Configuration options for the query.
 */
export function useQuery<TInput, TOutput>(
  // Procedure type needs careful handling. Using a function type for now.
  // Ideally, this would infer types from the procedure itself.
  queryProcedure: (input: TInput) => Promise<TOutput>,
  input: TInput,
  options: UseQueryOptions = {},
): UseQueryResult<TOutput> {
  const { client } = usezenQuery(); // Get client from context
  const { enabled = true } = options;

  // --- State Signals ---
  const dataSignal = signal<TOutput | undefined>(undefined);
  const errorSignal = signal<zenQueryClientError | null>(null);
  const isFetchingSignal = signal<boolean>(false);

  // --- Input Memoization ---
  // Stringify input to use as a stable dependency key in useEffect
  // Note: This assumes input is serializable and order doesn't matter if it's an object.
  // More robust serialization/hashing might be needed for complex inputs.
  const stableInputKey = useMemo(() => {
    try {
      // Sort object keys for stability if it's a plain object
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
      console.error("Failed to stringify query input for memoization:", input, e);
      // Fallback to a less stable key if stringify fails
      return String(Date.now()); // Or throw?
    }
  }, [input]);


  // --- Effect for Fetching ---
  useEffect(() => {
    if (!enabled) {
      // If disabled, ensure fetching state is false (might be true from a previous enabled state)
      isFetchingSignal.value = false;
      return; // Don't fetch if not enabled
    }

    let isCancelled = false; // Flag to prevent state updates on unmounted component

    const fetchData = async () => {
      // Reset error and set fetching state
      errorSignal.value = null;
      isFetchingSignal.value = true;

      try {
        // Use the actual client procedure passed to the hook
        // This relies on the caller passing e.g., client.post.get.query
        // Need to ensure the type of queryProcedure matches client methods
        const result = await queryProcedure(input);

        if (!isCancelled) {
          dataSignal.value = result;
          errorSignal.value = null; // Clear error on success
        }
      } catch (err: unknown) {
        console.error('useQuery failed:', err);
        if (!isCancelled) {
          // Assuming the error is or can be cast to zenQueryClientError
          // TODO: Improve error type handling/casting
          errorSignal.value = err as zenQueryClientError;
          dataSignal.value = undefined; // Clear data on error
        }
      } finally {
        if (!isCancelled) {
          isFetchingSignal.value = false;
        }
      }
    };

    fetchData();

    // Cleanup function to set the cancelled flag
    return () => {
      isCancelled = true;
    };
  }, [stableInputKey, enabled, queryProcedure]); // Re-run effect if input, enabled status, or procedure changes

  // --- Computed Signals (Optional) ---
  // const isSuccess = computed(() => dataSignal.value !== undefined && !isFetchingSignal.value && !errorSignal.value);
  // const isError = computed(() => errorSignal.value !== null);

  return {
    data: dataSignal,
    error: errorSignal,
    isFetching: isFetchingSignal,
    // isSuccess,
    // isError,
  };
}
