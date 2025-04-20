import { useEffect, useState, useMemo, useRef } from 'react';
import { useTypeQL } from '../context';
import type { TypeQLClientError } from '@sylphlab/typeql-client'; // Assuming error type export

// Define options for the useQuery hook
export interface UseQueryOptions {
  /** If false, the query will not execute automatically. Defaults to true. */
  enabled?: boolean;
  // TODO: Add other options like staleTime, cacheTime, refetchOnWindowFocus etc. later
}

// Define the return type of the useQuery hook using standard React state
export interface UseQueryResult<TData = unknown, TError = TypeQLClientError> {
  data: TData | undefined;
  error: TError | null;
  isFetching: boolean;
  // isSuccess: boolean; // Can be derived: data !== undefined && !isFetching && !error
  // isError: boolean; // Can be derived: error !== null
  // refetch: () => Promise<void>; // TODO: Add manual refetch capability
}

/**
 * Hook for fetching data using a TypeQL query.
 *
 * @param queryProcedure The client query procedure (e.g., client.post.get)
 * @param input Input parameters for the query procedure.
 * @param options Configuration options for the query.
 */
export function useQuery<TInput, TOutput>(
  // Procedure type needs careful handling. Using a function type for now.
  queryProcedure: (input: TInput) => Promise<TOutput>,
  input: TInput,
  options: UseQueryOptions = {},
): UseQueryResult<TOutput> {
  const { client } = useTypeQL(); // Get client from context
  const { enabled = true } = options;

  // --- State using useState ---
  const [data, setData] = useState<TOutput | undefined>(undefined);
  const [error, setError] = useState<TypeQLClientError | null>(null);
  const [isFetching, setIsFetching] = useState<boolean>(false);

  // Ref to track mounted state to prevent state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);


  // --- Input Memoization ---
  // Stringify input to use as a stable dependency key in useEffect
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
      // If disabled, ensure fetching state is false
      if (isFetching) setIsFetching(false);
      return; // Don't fetch if not enabled
    }

    const fetchData = async () => {
      // Reset error and set fetching state
      setError(null);
      setIsFetching(true);

      try {
        // Use the actual client procedure passed to the hook
        const result = await queryProcedure(input);

        if (mountedRef.current) {
          setData(result);
          setError(null); // Clear error on success
        }
      } catch (err: unknown) {
        console.error('useQuery failed:', err);
        if (mountedRef.current) {
          // Assuming the error is or can be cast to TypeQLClientError
          setError(err as TypeQLClientError);
          setData(undefined); // Clear data on error
        }
      } finally {
        if (mountedRef.current) {
          setIsFetching(false);
        }
      }
    };

    fetchData();

    // No specific cleanup needed here other than the mounted check
  }, [stableInputKey, enabled, queryProcedure]); // Re-run effect if input, enabled status, or procedure changes

  return {
    data,
    error,
    isFetching,
  };
}