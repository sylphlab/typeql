import { useMemo, useCallback } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals-core';
import { usezenQuery } from '../context';
import type { zenQueryClientError, MutationCallOptions } from '@sylphlab/zen-query-client'; // Assuming exports

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
  TVariables = unknown, // Input variables type including optimistic options
  TContext = unknown,
> {
  data: Signal<TData | undefined>;
  error: Signal<TError | null>;
  isLoading: Signal<boolean>; // Using isLoading for now.
  mutate: (variables: TVariables, options?: UseMutationOptions<TData, TError, TVariables, TContext>) => Promise<TData>;
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
  // Procedure type needs careful handling. Using a function type for now.
  mutationProcedure: (opts: MutationCallOptions<TInput, TState>) => Promise<TOutput>,
  options: UseMutationOptions<TOutput, TError, MutationCallOptions<TInput, TState>, TContext> = {},
): UseMutationResult<TOutput, TError, MutationCallOptions<TInput, TState>, TContext> {
  const { client, store } = usezenQuery<TState>(); // Get client and store from context

  // --- State Signals ---
  const dataSignal = signal<TOutput | undefined>(undefined);
  const errorSignal = signal<TError | null>(null);
  const isLoadingSignal = signal<boolean>(false);
  const contextSignal = signal<TContext | void>(undefined); // Store context from onMutate

  // --- Reset Function ---
  const reset = useCallback(() => {
    dataSignal.value = undefined;
    errorSignal.value = null;
    isLoadingSignal.value = false;
    contextSignal.value = undefined;
  }, []); // No dependencies needed for reset

  // --- Mutate Function ---
  const mutateAsync = useCallback(
    async (
      variables: MutationCallOptions<TInput, TState>, // Variables now include input + optimistic opts
      runtimeOptions?: UseMutationOptions<TOutput, TError, MutationCallOptions<TInput, TState>, TContext>,
    ): Promise<TOutput> => {
      const combinedOptions = { ...options, ...runtimeOptions };
      isLoadingSignal.value = true;
      errorSignal.value = null; // Clear previous error
      contextSignal.value = undefined; // Clear previous context

      try {
        // Call onMutate callback if provided
        contextSignal.value = await combinedOptions.onMutate?.(variables);

        // Call the actual client mutation procedure
        const result = await mutationProcedure(variables);

        // Call onSuccess callback
        await combinedOptions.onSuccess?.(result, variables, contextSignal.value);

        dataSignal.value = result;
        return result;
      } catch (err: unknown) {
        console.error('useMutation failed:', err);
        const error = err as TError; // Assume error is of type TError

        // Call onError callback
        await combinedOptions.onError?.(error, variables, contextSignal.value);

        errorSignal.value = error;
        dataSignal.value = undefined; // Clear data on error
        throw error; // Re-throw error after handling callbacks
      } finally {
        // Call onSettled callback
        await combinedOptions.onSettled?.(dataSignal.value, errorSignal.value, variables, contextSignal.value);
        isLoadingSignal.value = false;
      }
    },
    [mutationProcedure, options, reset], // Include options and reset in dependencies
  );

  // --- Fire-and-forget mutate ---
  const mutate = useCallback(
    (
      variables: MutationCallOptions<TInput, TState>,
      runtimeOptions?: UseMutationOptions<TOutput, TError, MutationCallOptions<TInput, TState>, TContext>,
    ): Promise<TOutput> => { // Still return promise, but don't wait for caller necessarily
      return mutateAsync(variables, runtimeOptions).catch(() => {
        // Prevent unhandled promise rejection if caller doesn't catch
        // The error is already stored in the errorSignal and onError called.
      });
    },
    [mutateAsync],
  );


  return {
    data: dataSignal,
    error: errorSignal,
    isLoading: isLoadingSignal,
    mutate,
    mutateAsync,
    reset,
  };
}
