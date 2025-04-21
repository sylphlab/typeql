import { useState, useCallback, useRef, useEffect } from 'react';
import { usezenQuery } from '../context';
import type { zenQueryClientError } from '@sylphlab/zen-query-shared'; // Import error from shared
// Removed MutationCallOptions import

// Define options for the useMutation hook
export interface UseMutationOptions<
  TData = unknown,
  TError = zenQueryClientError,
  TVariables = unknown, // Input variables type
  TContext = unknown, // Context for optimistic updates/callbacks
> {
  onMutate?: (variables: TVariables) => Promise<TContext | void> | TContext | void;
  onSuccess?: (data: TData, variables: TVariables, context?: TContext) => Promise<void> | void;
  onError?: (error: TError, variables: TVariables, context?: TContext) => Promise<void> | void;
  onSettled?: (data: TData | undefined, error: TError | null, variables: TVariables, context?: TContext) => Promise<void> | void;
}

// Define the return type of the useMutation hook
export interface UseMutationResult<
  TData = unknown,
  TError = zenQueryClientError,
  TVariables = unknown, // Input variables type
  TContext = unknown,
> {
  data: TData | undefined;
  error: TError | null;
  isLoading: boolean; // Using isLoading for mutation status
  mutate: (variables: TVariables, options?: UseMutationOptions<TData, TError, TVariables, TContext>) => void;
  mutateAsync: (variables: TVariables, options?: UseMutationOptions<TData, TError, TVariables, TContext>) => Promise<TData>;
  reset: () => void;
}

/**
 * Hook for executing zenQuery mutations.
 *
 * @param mutationProcedure The client mutation procedure (e.g., client.post.create.mutate)
 * @param options Configuration options like callbacks (onSuccess, onError).
 */
export function useMutation<
  TInput, // Input type for the procedure itself
  TOutput, // Output type of the procedure
  TError = zenQueryClientError,
  TState = any, // State type for optimistic updates
  TContext = unknown, // Context type for callbacks
>(
  // Procedure type expects the raw input
  mutationProcedure: (input: TInput) => Promise<TOutput>,
  options: UseMutationOptions<TOutput, TError, TInput, TContext> = {},
): UseMutationResult<TOutput, TError, TInput, TContext> {
  const { client, store } = usezenQuery<TState>(); // Get client and store from context

  // --- State using useState ---
  const [data, setData] = useState<TOutput | undefined>(undefined);
  const [error, setError] = useState<TError | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  // Use a ref to store context from onMutate to avoid re-rendering when it changes
  const mutationContextRef = useRef<TContext | void>(undefined);

  // Ref to track mounted state
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);


  // --- Reset Function ---
  const reset = useCallback(() => {
    if (mountedRef.current) {
      setData(undefined);
      setError(null);
      setIsLoading(false);
      mutationContextRef.current = undefined;
    }
  }, []); // No dependencies needed for reset

  // --- Mutate Function ---
  const mutateAsync = useCallback(
    async (
      variables: TInput, // Use raw input type
      runtimeOptions?: UseMutationOptions<TOutput, TError, TInput, TContext>,
    ): Promise<TOutput> => {
      const combinedOptions = { ...options, ...runtimeOptions };
      if (mountedRef.current) {
        setIsLoading(true);
        setError(null); // Clear previous error
        mutationContextRef.current = undefined; // Clear previous context
      } else {
        // Should not happen if called correctly, but good practice
        return Promise.reject(new Error("Mutation attempted on unmounted component"));
      }


      let finalData: TOutput | undefined = undefined;
      let finalError: TError | null = null;
      try {
        // Call onMutate callback if provided
        mutationContextRef.current = await combinedOptions.onMutate?.(variables);

        // Call the actual client mutation procedure
        finalData = await mutationProcedure(variables); // Store result

        if (mountedRef.current) {
          // Call onSuccess callback
          await combinedOptions.onSuccess?.(finalData, variables, mutationContextRef.current ?? undefined); // Pass undefined if void
          setData(finalData);
          setError(null); // Clear error on success
        }
        return finalData; // Return result even if unmounted after success
      } catch (err: unknown) {
        // console.error('useMutation failed:', err); // Removed log
        finalError = err as TError; // Store error

        if (mountedRef.current) {
          // Call onError callback
          await combinedOptions.onError?.(finalError, variables, mutationContextRef.current ?? undefined); // Pass undefined if void
          setError(finalError);
          setData(undefined); // Clear data on error
        }
        throw finalError; // Re-throw error after handling callbacks
      } finally {
        // Call onSettled callback using the captured finalData/finalError
         if (mountedRef.current) {
            // Use finalData and finalError captured in the try/catch scope
            await combinedOptions.onSettled?.(finalData, finalError, variables, mutationContextRef.current ?? undefined);
            setIsLoading(false);
         } else {
            // Optionally call onSettled even if unmounted, depending on desired behavior
            // await combinedOptions.onSettled?.(data, error, variables, mutationContextRef.current);
         }
      }
    },
    // Include mutationProcedure and default options in dependencies.
    // client/store are stable from context. reset is stable.
    [mutationProcedure, options],
  );

  // --- Fire-and-forget mutate ---
  const mutate = useCallback(
    (
      variables: TInput, // Use raw input type
      runtimeOptions?: UseMutationOptions<TOutput, TError, TInput, TContext>,
    ): void => {
      mutateAsync(variables, runtimeOptions).catch(() => {
        // Prevent unhandled promise rejection. Error is handled internally.
      });
    },
    [mutateAsync],
  );


  return {
    data,
    error,
    isLoading,
    mutate,
    mutateAsync,
    reset,
  };
}