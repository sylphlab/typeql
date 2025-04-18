// packages/preact/src/hooks/useMutation.ts
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import {
    AnyRouter,
    TypeQLClientError,
} from '@sylphlab/typeql-shared';
import {
    MutationCallOptions,
    PredictedChange,
} from '@sylphlab/typeql-client';
import { useTypeQL } from '../context';

// Helper types
type inferMutationInput<TProcedure> = TProcedure extends { mutate: (opts: { input: infer TIn }) => any }
    ? TIn
    : never;

type inferMutationOutput<TProcedure> = TProcedure extends { mutate: (...args: any[]) => Promise<infer TOutput> }
    ? TOutput
    : never;

// Options interface
export interface UseMutationOptions<TOutput, TInput, TState = any> {
     optimistic?: {
        predictedChange: PredictedChange<TState>;
     };
    onSuccess?: (data: TOutput, variables: TInput) => Promise<void> | void;
    onError?: (error: TypeQLClientError | Error, variables: TInput) => Promise<void> | void;
    onMutate?: (variables: TInput) => Promise<any> | void;
    // onSettled?: (data: TOutput | undefined, error: TypeQLClientError | Error | null, variables: TInput, context?: any) => Promise<void> | void; // Placeholder
    // retry?: number; // Placeholder
}

// Result interface
export interface UseMutationResult<TOutput, TInput, TState = any> {
    mutate: (input: TInput) => Promise<TOutput>;
    mutateAsync: (input: TInput) => Promise<TOutput>;
    isLoading: boolean;
    isSuccess: boolean;
    isError: boolean;
    error: TypeQLClientError | Error | null;
    data: TOutput | undefined;
    status: 'idle' | 'loading' | 'error' | 'success';
    reset: () => void;
}

// Hook implementation
export function useMutation<
    TProcedure extends { mutate: (opts: MutationCallOptions<any, any>) => Promise<any> },
    TInputArgs = Parameters<TProcedure['mutate']>[0],
    TInput = TInputArgs extends MutationCallOptions<infer In, any> ? In : never,
    TOutput = Awaited<ReturnType<TProcedure['mutate']>>,
    TState = any
>(
    procedure: TProcedure,
    options?: UseMutationOptions<TOutput, TInput, TState>
): UseMutationResult<TOutput, TInput, TState> {
    const { client, store } = useTypeQL<AnyRouter, TState>();
    const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'success'>('idle');
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [data, setData] = useState<TOutput | undefined>(undefined);

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

    const executeMutationInternal = useCallback(async (input: TInput): Promise<TOutput> => {
         if (!isMountedRef.current) {
             throw new TypeQLClientError("Component unmounted before mutation could complete.");
        }

        setStatus('loading');
        setError(null);
        setData(undefined);

        try {
            let optimisticArg: MutationCallOptions<TInput, TState>['optimistic'] | undefined;
            if (store && optionsRef.current?.optimistic && optionsRef.current.optimistic.predictedChange) {
                optimisticArg = {
                     predictedChange: optionsRef.current.optimistic.predictedChange,
                 };
                 console.log("[useMutation] Preparing optimistic update arguments.");
            }

            await optionsRef.current?.onMutate?.(input);

            const mutationArgs: MutationCallOptions<TInput, TState> = {
                input,
                ...(optimisticArg && { optimistic: optimisticArg })
            };

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
             console.error("[TypeQL Preact] useMutation Error:", err);
             const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
             if (isMountedRef.current) {
                 setError(errorObj);
                 setStatus('error');
                 optionsRef.current?.onError?.(errorObj, input);
             }
             throw errorObj;
        }
    }, [procedure, store]);

    const triggerMutation = useCallback((input: TInput) => {
        return executeMutationInternal(input);
    }, [executeMutationInternal]);


    return {
        mutate: triggerMutation,
        mutateAsync: triggerMutation,
        isLoading: status === 'loading',
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        data,
        status,
        reset,
    };
}