// packages/react/src/hooks/useMutation.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { AnyRouter, TypeQLClientError } from '@sylphlab/typeql-shared';
import { MutationCallOptions, PredictedChange } from '@sylphlab/typeql-client';
import { useTypeQL } from '../context'; // Import from the context file

// --- Mutation Hook ---

// Refined Helper types for mutation
// Infer TInput from the `input` property of the options object expected by procedure.mutate
type inferMutationInput<TProcedure> = TProcedure extends { mutate: (opts: { input: infer TIn }) => any }
    ? TIn
    : never;

type inferMutationOutput<TProcedure> = TProcedure extends { mutate: (...args: any[]) => Promise<infer TOutput> }
    ? TOutput
    : never;

/**
 * Options for configuring the useMutation hook.
 * @template TOutput The expected output type of the mutation.
 * @template TInput The input type of the mutation.
 * @template TState The state type used by the optimistic store.
 */
export interface UseMutationOptions<TOutput, TInput, TState = any> {
     /**
      * Provides the predicted change for an optimistic update.
      * If provided alongside an OptimisticStore in context, the mutation will be applied optimistically.
      */
     optimistic?: {
        predictedChange: PredictedChange<TState>;
     };
    /**
     * Callback function fired when the mutation is successful.
     * @param data The data returned by the mutation.
     * @param variables The input variables the mutation was called with.
     */
    onSuccess?: (data: TOutput, variables: TInput) => Promise<void> | void;
    /**
     * Callback function fired when the mutation encounters an error.
     * @param error The error object (TypeQLClientError or generic Error).
     * @param variables The input variables the mutation was called with.
     */
    onError?: (error: TypeQLClientError | Error, variables: TInput) => Promise<void> | void;
    /**
     * Callback function fired before the mutation function is fired.
     * Useful for optimistic updates. It receives the variables the mutation will be called with.
     * If it returns a promise, that promise will be awaited before the mutation fires.
     * It can optionally return a context value that will be passed to onError or onSettled.
     * @placeholder Currently does not support context passing like React Query.
     * @param variables The input variables the mutation will be called with.
     */
    onMutate?: (variables: TInput) => Promise<any> | void;
    /**
     * @placeholder Callback function fired when the mutation is finished (either successfully or with an error).
     * @param data The data returned by the mutation (if successful).
     * @param error The error object (if mutation failed).
     * @param variables The input variables the mutation was called with.
     * @param context The context value returned from onMutate (if used).
     */
    // onSettled?: (data: TOutput | undefined, error: TypeQLClientError | Error | null, variables: TInput, context?: any) => Promise<void> | void;
    /**
     * @placeholder Number of times the mutation will automatically retry on failure. Defaults to 0.
     */
    // retry?: number;
}

/**
 * Represents the state and functions returned by the useMutation hook.
 * @template TOutput The expected output type of the mutation.
 * @template TInput The input type of the mutation.
 * @template TState The state type used by the optimistic store.
 */
export interface UseMutationResult<TOutput, TInput, TState = any> {
    /**
     * Function to trigger the mutation. Pass the input variables.
     * If optimistic options were provided to `useMutation`, they will be used internally.
     * Returns a Promise that resolves with the mutation result on success or rejects with an error on failure.
     */
    mutate: (input: TInput) => Promise<TOutput>;
    /**
     * Same as `mutate`, but explicitly named for async/await usage clarity.
     */
    mutateAsync: (input: TInput) => Promise<TOutput>;
    /**
     * True if the mutation is currently executing.
     */
    isLoading: boolean;
    /**
     * True if the mutation completed successfully.
     */
    isSuccess: boolean;
    /**
     * True if the mutation encountered an error.
     */
    isError: boolean;
    /**
     * The error object if the mutation failed, otherwise null.
     */
    error: TypeQLClientError | Error | null;
    /**
     * The data returned by the last successful mutation execution. Undefined otherwise.
     */
    data: TOutput | undefined;
    /**
     * The current status of the mutation: 'idle', 'loading', 'error', or 'success'.
     */
    status: 'idle' | 'loading' | 'error' | 'success';
    /**
     * Function to reset the mutation state back to 'idle', clearing any data or error.
     */
    reset: () => void;
}

/**
 * Hook to perform a TypeQL mutation.
 * Provides functions to trigger the mutation and tracks its state (loading, success, error, data).
 * Supports optimistic updates if an OptimisticStore is provided via context and optimistic options are configured.
 *
 * @template TProcedure The type of the TypeQL procedure (e.g., `client.users.create`). Needs a `mutate` method expecting `MutationCallOptions`.
 * @template TInput The inferred input type of the mutation procedure.
 * @template TOutput The inferred output type of the mutation procedure.
 * @template TState The state type managed by the optimistic store.
 * @param procedure The TypeQL mutation procedure object (e.g., `client.users.create`).
 * @param options Optional configuration for the mutation behavior, callbacks, and optimistic updates.
 * @returns An object containing the mutation state (`isLoading`, `isSuccess`, `isError`, `error`, `data`, `status`) and functions (`mutate`, `mutateAsync`, `reset`).
 */
export function useMutation<
    // Ensure the procedure's mutate expects MutationCallOptions
    TProcedure extends { mutate: (opts: MutationCallOptions<any, any>) => Promise<any> },
    // Infer TInput directly from the 'input' property of the options object
    TInputArgs = Parameters<TProcedure['mutate']>[0],
    TInput = TInputArgs extends { input: infer In } ? In : never, // Infer from input property
    TOutput = Awaited<ReturnType<TProcedure['mutate']>>, // Infer output from the promise
    TState = any // Add state generic for store
>(
    procedure: TProcedure,
    options?: UseMutationOptions<TOutput, TInput, TState> // Hook options include TState
): UseMutationResult<TOutput, TInput, TState> { // Add TState to result type
    // Use the hook that provides both client and store
    const { client, store } = useTypeQL<AnyRouter, TState>(); // Get store instance
    const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'success'>('idle');
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [data, setData] = useState<TOutput | undefined>(undefined);

    // Use ref for options to keep callback stable
    const optionsRef = useRef(options);
    useEffect(() => {
        optionsRef.current = options;
    }, [options]);

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const reset = useCallback(() => {
        if (isMountedRef.current) {
            setStatus('idle');
            setError(null);
            setData(undefined);
        }
    }, []);

    // The internal execution function, accepts the raw input
    const executeMutationInternal = useCallback(async (input: TInput): Promise<TOutput> => {
         if (!isMountedRef.current) {
             throw new TypeQLClientError("Component unmounted before mutation could complete.");
        }

        setStatus('loading');
        setError(null);
        setData(undefined);

        try {
            // --- Prepare optimistic options from the hook's configuration ---
            let optimisticArg: MutationCallOptions<TInput, TState>['optimistic'] | undefined;
            // Check for store and optimistic config in hook options
            if (store && optionsRef.current?.optimistic && optionsRef.current.optimistic.predictedChange) {
                optimisticArg = {
                     predictedChange: optionsRef.current.optimistic.predictedChange,
                 };
                 console.log("[useMutation] Preparing optimistic update arguments.");
            }
            // --- End Prepare optimistic options ---

            // Call the hook's onMutate callback *before* the procedure call
            await optionsRef.current?.onMutate?.(input);

            // Prepare the arguments for the client proxy's mutate method
            const mutationArgs: MutationCallOptions<TInput, TState> = {
                input,
                ...(optimisticArg && { optimistic: optimisticArg }) // Conditionally add optimistic part
            };

            // Pass the mutationArgs (containing input and potentially optimistic) to the client proxy's mutate method
            // Assume `procedure.mutate` is the actual method on the client proxy
            const result = await procedure.mutate(mutationArgs);

            if (isMountedRef.current) {
                setData(result as TOutput);
                setStatus('success');
                optionsRef.current?.onSuccess?.(result as TOutput, input);
                return result as TOutput;
            } else {
                 throw new TypeQLClientError("Component unmounted after mutation success but before state update.");
            }
        } catch (err: any) {
             console.error("[TypeQL React] useMutation Error:", err); // Add specific logging
             // Consistent error handling like useQuery
             const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
             if (isMountedRef.current) {
                 setError(errorObj);
                 setStatus('error');
                 optionsRef.current?.onError?.(errorObj, input);
             }
             // Re-throw the error so the caller's await Promise rejects
             throw errorObj;
        }
    }, [procedure, store]); // Dependencies: procedure ref and store instance

    // The function returned to the user, accepts raw input
    const triggerMutation = useCallback((input: TInput) => {
        return executeMutationInternal(input);
    }, [executeMutationInternal]);


    return {
        mutate: triggerMutation, // Provide main function
        mutateAsync: triggerMutation, // Explicit async name
        isLoading: status === 'loading',
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        data,
        status,
        reset,
    };
}