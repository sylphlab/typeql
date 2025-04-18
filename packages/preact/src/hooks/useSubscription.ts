// packages/preact/src/hooks/useSubscription.ts
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import {
    AnyRouter,
    TypeQLClientError,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
} from '@sylphlab/typeql-shared';
import { useTypeQL } from '../context';

// Helper types
type inferSubscriptionDataType<TProcedure> =
    TProcedure extends { subscribe: (...args: any[]) => { iterator: AsyncIterableIterator<infer TMessage> } }
        ? TMessage extends { type: 'subscriptionData'; data: infer TData }
            ? TData
            : unknown
        : unknown;

type inferSubscriptionInput<TProcedure> = TProcedure extends { subscribe: (input: infer TInput) => any }
    ? TInput
    : never;

// Options interface
export interface UseSubscriptionOptions<TOutput> {
    enabled?: boolean;
    onData?: (data: TOutput) => void;
    onError?: (error: SubscriptionErrorMessage['error']) => void;
    onEnd?: () => void;
    onStart?: () => void;
    // retry?: boolean; // Placeholder
}

// Result interface
export interface UseSubscriptionResult<TOutput> {
    data: TOutput | null;
    status: 'idle' | 'connecting' | 'active' | 'error' | 'ended';
    error: TypeQLClientError | Error | null;
    unsubscribe: UnsubscribeFn | null;
}

// Hook implementation
export function useSubscription<
    TProcedure extends { subscribe: (input: any) => { iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>, unsubscribe: UnsubscribeFn } },
    TInput = inferSubscriptionInput<TProcedure>,
    TOutput = inferSubscriptionDataType<TProcedure>
>(
    procedure: TProcedure,
    input: TInput,
    options?: UseSubscriptionOptions<TOutput>
): UseSubscriptionResult<TOutput> {
    const { enabled = true } = options ?? {};
    const { client, store } = useTypeQL();

    const [status, setStatus] = useState<'idle' | 'connecting' | 'active' | 'error' | 'ended'>(
        enabled ? 'connecting' : 'idle'
    );
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [data, setData] = useState<TOutput | null>(null);
    const [unsubscribeFn, setUnsubscribeFn] = useState<UnsubscribeFn | null>(null);

    const onDataRef = useRef(options?.onData);
    const onErrorRef = useRef(options?.onError);
    const onEndRef = useRef(options?.onEnd);
    const onStartRef = useRef(options?.onStart);

    useEffect(() => {
        onDataRef.current = options?.onData;
        onErrorRef.current = options?.onError;
        onEndRef.current = options?.onEnd;
        onStartRef.current = options?.onStart;
    }, [options?.onData, options?.onError, options?.onEnd, options?.onStart]);

    const inputKey = useMemo(() => {
        try {
            return JSON.stringify(input);
        } catch {
            console.warn("useSubscription: Failed to stringify input for dependency key. Updates may be missed for complex objects.");
            return String(input);
        }
    }, [input]);

    const isMountedRef = useRef(true);
    const isUnsubscribedRef = useRef(false);
    useEffect(() => {
        isMountedRef.current = true;
        isUnsubscribedRef.current = false;
        return () => { isMountedRef.current = false; };
    }, []);


    useEffect(() => {
        if (!enabled || !procedure) {
            if (unsubscribeFn) {
                if (!isUnsubscribedRef.current) {
                    console.log("[useSubscription] Cleaning up subscription (disabled/procedure changed).");
                    try { unsubscribeFn(); } catch (e) { console.warn("Error unsubscribing:", e); }
                    isUnsubscribedRef.current = true;
                }
                setUnsubscribeFn(null);
            }
            if (status !== 'idle') {
                setStatus('idle'); setError(null); setData(null);
            }
            return;
        }

        let unsub: UnsubscribeFn | null = null;
        let iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> | null = null;
        let isEffectCancelled = false;

        isUnsubscribedRef.current = false;

        const processNext = async () => {
            if (!isMountedRef.current || isEffectCancelled || isUnsubscribedRef.current || !iterator) {
                console.log("[useSubscription] Stopping iterator processing.");
                return;
            }

            try {
                const { value, done } = await iterator.next();

                if (!isMountedRef.current || isEffectCancelled || isUnsubscribedRef.current) {
                    console.log("[useSubscription] Stopping iterator processing after await.");
                    return;
                }

                if (done) {
                    console.log("[useSubscription] Subscription ended normally (iterator done).");
                    if (status !== 'error') {
                        setStatus('ended');
                        onEndRef.current?.();
                    }
                    return;
                }

                const result = value;
                if (result.type === 'subscriptionData') {
                    if (status !== 'active') setStatus('active');
                    setError(null);
                    const dataPayload = result.data as TOutput;

                    if (store) {
                        try {
                            store.applyServerDelta(result);
                            console.debug("[useSubscription] Applied server delta to store:", result.serverSeq);
                            onDataRef.current?.(dataPayload);
                            setData(dataPayload);
                        } catch (storeError: any) {
                            console.error("[useSubscription] Error applying server delta to store:", storeError);
                            const err = storeError instanceof Error ? storeError : new Error(String(storeError));
                            setError(err); setStatus('error');
                            onErrorRef.current?.({ message: `Store error: ${err.message || err}` });
                            return;
                        }
                    } else {
                        setData(dataPayload);
                        onDataRef.current?.(dataPayload);
                    }
                } else if (result.type === 'subscriptionError') {
                    console.error("[useSubscription] Subscription error received:", result.error);
                    const clientError = new TypeQLClientError(result.error.message, result.error.code);
                    setError(clientError); setStatus('error');
                    onErrorRef.current?.(result.error);
                    return;
                }

                Promise.resolve().then(processNext);

            } catch (err: any) {
                if (isMountedRef.current && !isEffectCancelled && !isUnsubscribedRef.current) {
                    console.error("[TypeQL Preact] useSubscription Error (iterator.next):", err);
                    const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
                    setError(errorObj); setStatus('error');
                    onErrorRef.current?.({ message: `Subscription failed: ${errorObj.message || errorObj}` });
                }
            }
        };

        const startSubscription = async () => {
            if (!isMountedRef.current || isEffectCancelled) return;

            setStatus('connecting');
            setError(null);
            setData(null);

            try {
                const subResult = procedure.subscribe(input);
                unsub = subResult.unsubscribe;
                iterator = subResult.iterator;

                const manualUnsubscribe = () => {
                    if (unsub && !isUnsubscribedRef.current) {
                        console.log("[useSubscription] Manually unsubscribing.");
                        try { unsub(); } catch (e) { console.warn("Error unsubscribing:", e); }
                        isUnsubscribedRef.current = true;
                        if (isMountedRef.current) setStatus('idle');
                    }
                };

                if (isMountedRef.current && !isEffectCancelled) {
                    setUnsubscribeFn(() => manualUnsubscribe);
                } else {
                    if (unsub && !isUnsubscribedRef.current) {
                        try { unsub(); } catch (e) { console.warn("Error unsubscribing:", e); }
                        isUnsubscribedRef.current = true;
                    }
                    return;
                }

                onStartRef.current?.();

                processNext();

            } catch (err: any) {
                if (isMountedRef.current && !isEffectCancelled) {
                    console.error("[TypeQL Preact] useSubscription Error (subscribe call):", err);
                    const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
                    setError(errorObj); setStatus('error');
                    onErrorRef.current?.({ message: `Subscription failed: ${errorObj.message || errorObj}` });
                }
            }
        };

        startSubscription();

        return () => {
            isEffectCancelled = true;
            if (unsub && !isUnsubscribedRef.current) {
                console.log("[useSubscription] Cleaning up subscription (effect cleanup).");
                try { unsub(); } catch (e) { console.warn("Error unsubscribing:", e); }
                isUnsubscribedRef.current = true;
            }
            setUnsubscribeFn(null);
            if ((status === 'active' || status === 'connecting') && !isUnsubscribedRef.current) {
                 setStatus('idle');
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [procedure, inputKey, enabled, client, store]); // Added client back? No, store was correct.

    return { status, error, data, unsubscribe: unsubscribeFn };
}