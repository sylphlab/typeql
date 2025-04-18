// packages/react/src/hooks/useSubscription.ts
import { useState, useEffect, useRef, useMemo } from 'react';
import {
    AnyRouter,
    TypeQLClientError,
    UnsubscribeFn,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
} from '@sylphlab/typeql-shared';
import { useTypeQL } from '../context'; // Import from the context file

// --- Subscription Hook ---

// Helper type to infer the data type from the SubscriptionDataMessage yielded by the iterator
// Note: This assumes the iterator yields SubscriptionDataMessage | SubscriptionErrorMessage
type inferSubscriptionDataType<TProcedure> =
    TProcedure extends { subscribe: (...args: any[]) => { iterator: AsyncIterableIterator<infer TMessage> } }
        ? TMessage extends { type: 'subscriptionData'; data: infer TData } // Check structure and infer data type
            ? TData // Use the inferred data type
            : unknown // Fallback if not the expected structure
        : unknown;

// Helper type to infer the input type from the client's subscribe method
type inferSubscriptionInput<TProcedure> = TProcedure extends { subscribe: (input: infer TInput) => any }
    ? TInput
    : never;


/**
 * Options for configuring the useSubscription hook.
 * Includes callbacks for handling subscription events.
 * @template TOutput The expected data type received from the subscription.
 */
export interface UseSubscriptionOptions<TOutput> {
    /**
     * If false, the subscription will not be established automatically. Defaults to true.
     */
    enabled?: boolean;
    /** Callback for when data is received */
    onData?: (data: TOutput) => void;
    /** Callback for when an error occurs */
    onError?: (error: SubscriptionErrorMessage['error']) => void;
    /** Callback for when the subscription ends normally */
    onEnd?: () => void;
    /** Callback for when the subscription starts (transport confirms) */
    onStart?: () => void;
    /**
     * @placeholder If true, the subscription will automatically attempt to reconnect on error.
     */
    // retry?: boolean;
}

/**
 * Represents the state returned by the useSubscription hook.
 * @template TOutput The expected data type received from the subscription.
 */
export interface UseSubscriptionResult<TOutput> {
    /**
     * The latest data received from the subscription. Null initially or if an error occurs.
     * Note: If using an OptimisticStore, prefer selecting data from the store using `useQuery` or similar.
     */
    data: TOutput | null;
    /**
     * The current status of the subscription:
     * - 'idle': Not active or attempting to connect (usually when `enabled` is false).
     * - 'connecting': Attempting to establish the WebSocket connection or send the initial subscribe message.
     * - 'active': Subscription is established and receiving data (or waiting for data after `onStart`).
     * - 'error': An error occurred.
     * - 'ended': The subscription ended gracefully.
     */
    status: 'idle' | 'connecting' | 'active' | 'error' | 'ended';
    /**
     * The error object if the subscription failed or encountered an error during its lifecycle, otherwise null.
     */
    error: TypeQLClientError | Error | null;
    /**
     * Function to manually unsubscribe from the subscription.
     */
    unsubscribe: UnsubscribeFn | null;
}

/**
 * Hook to subscribe to a TypeQL subscription and receive real-time delta updates using Async Iterators.
 *
 * @template TProcedure The type of the TypeQL subscription procedure (e.g., `client.messages.onNewMessage`).
 * @template TInput The inferred input type of the subscription procedure.
 * @template TOutput The inferred output type from the procedure's subscription output schema.
 * @param procedure The TypeQL subscription procedure object (e.g., `client.messages.onNewMessage`).
 * @param input The input arguments for the subscription procedure.
 * @param options Optional configuration including `enabled` flag and event callbacks (`onData`, `onError`, `onEnd`, `onStart`).
 * @returns An object containing the subscription state (`status`, `error`, `data`, `unsubscribe`).
 */
export function useSubscription<
    // Procedure should have a subscribe method returning { iterator, unsubscribe } yielding full messages
    TProcedure extends { subscribe: (input: any) => { iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>, unsubscribe: UnsubscribeFn } },
    TInput = inferSubscriptionInput<TProcedure>,
    // Use the updated helper to infer the data type
    TOutput = inferSubscriptionDataType<TProcedure>
>(
    procedure: TProcedure,
    input: TInput,
    options?: UseSubscriptionOptions<TOutput>
): UseSubscriptionResult<TOutput> {
    const { enabled = true } = options ?? {};
    const { client, store } = useTypeQL(); // Get client and store

    const [status, setStatus] = useState<'idle' | 'connecting' | 'active' | 'error' | 'ended'>(
        enabled ? 'connecting' : 'idle'
    );
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [data, setData] = useState<TOutput | null>(null); // Store latest data locally
    const [unsubscribeFn, setUnsubscribeFn] = useState<UnsubscribeFn | null>(null);

    // Use refs for callbacks to keep effect stable
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

    // Serialize input for dependency array
    const inputKey = useMemo(() => {
        try {
            return JSON.stringify(input);
        } catch {
            console.warn("useSubscription: Failed to stringify input for dependency key. Updates may be missed for complex objects.");
            return String(input); // Basic fallback
        }
    }, [input]);

    // Ref to track mounted state
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);


    useEffect(() => { // Main subscription effect
        if (!enabled || !procedure) {
            // Clean up subscription if disabled or procedure missing
            unsubscribeFn?.();
            setUnsubscribeFn(null);
            if (status !== 'idle') {
                setStatus('idle');
                setError(null);
                setData(null);
            }
            return;
        }

        let unsub: UnsubscribeFn | null = null;
        // Iterator now yields the full message types
        let iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> | null = null;
        let isCancelled = false; // Flag to prevent processing after cleanup

        const startSubscription = async () => {
            if (!isMountedRef.current || isCancelled) return;

            setStatus('connecting');
            setError(null);
            setData(null);

            try {
                // Start the subscription - client proxy handles path resolution
                const subResult = procedure.subscribe(input);
                unsub = subResult.unsubscribe;
                iterator = subResult.iterator; // No assertion needed, type matches
                if (isMountedRef.current && !isCancelled) {
                    setUnsubscribeFn(() => unsub); // Store the actual unsubscribe function
                } else {
                    // If unmounted or cancelled before setting state, immediately unsubscribe
                    unsub?.();
                    return;
                }

                onStartRef.current?.(); // Notify start

                // Consume the iterator
                for await (const result of iterator) {
                    if (!isMountedRef.current || isCancelled) break; // Stop if component unmounted or cancelled

                    // Iterator now yields SubscriptionDataMessage or SubscriptionErrorMessage
                    if (result.type === 'subscriptionData') {
                        if (status !== 'active') setStatus('active'); // Move to active on first data
                        setError(null); // Clear error on data

                        const dataPayload = result.data as TOutput; // Extract data payload

                        // If store exists, apply the full message
                        if (store) {
                            try {
                                // Pass the complete SubscriptionDataMessage to the store
                                store.applyServerDelta(result);
                                console.debug("[useSubscription] Applied server delta to store:", result.serverSeq);

                                // Call user's onData with the extracted payload
                                onDataRef.current?.(dataPayload);
                                // Update local state with the extracted payload
                                setData(dataPayload);

                            } catch (storeError: any) {
                                 console.error("[useSubscription] Error applying server delta to store:", storeError);
                                 const err = storeError instanceof Error ? storeError : new Error(String(storeError));
                                 if (isMountedRef.current && !isCancelled) {
                                     setError(err);
                                     setStatus('error');
                                     // Pass the original error structure to the callback
                                     onErrorRef.current?.({ message: `Store error: ${err.message || err}` });
                                 }
                                 break; // Stop iteration on store error
                            }
                        } else {
                            // No store, update local state and call handler with extracted payload
                            setData(dataPayload);
                            onDataRef.current?.(dataPayload);
                        }
                    } else if (result.type === 'subscriptionError') {
                        // Handle the error message yielded by the iterator
                        console.error("[useSubscription] Subscription error received:", result.error);
                        if (isMountedRef.current && !isCancelled) {
                            // Create a client-side error object for the hook's state
                            const clientError = new TypeQLClientError(result.error.message, result.error.code);
                            setError(clientError);
                            setStatus('error');
                            // Pass the original error structure from the message to the callback
                            onErrorRef.current?.(result.error);
                        }
                        break; // Stop iteration on error
                    }
                    // Note: The loop naturally ends when the iterator is done (server sends 'end')
                }

                // Iteration finished normally (server sent 'end' or iterator completed)
                if (isMountedRef.current && !isCancelled && status !== 'error') {
                    console.log("[useSubscription] Subscription ended normally.");
                    setStatus('ended');
                    onEndRef.current?.();
                }

            } catch (err: any) {
                if (isMountedRef.current && !isCancelled) {
                    console.error("[useSubscription] Failed to initiate or iterate subscription:", err);
                    const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
                    setError(errorObj);
                    setStatus('error');
                    onErrorRef.current?.({ message: `Subscription failed: ${errorObj.message || errorObj}` });
                }
            } finally {
                 if (isMountedRef.current && !isCancelled && status !== 'ended' && status !== 'error') {
                     // If loop finishes without explicit end/error (e.g., iterator.return called), mark as ended
                     // setStatus('ended'); // Or maybe 'idle'? Let's stick to 'ended' if it was active/connecting
                 }
                 // Ensure loading is false if it finishes in any state other than connecting/active
                 if (isMountedRef.current && !isCancelled && (status === 'connecting' || status === 'active')) {
                     // This case shouldn't ideally happen if loop finishes, but as a safeguard
                     // setStatus('ended'); // Or 'idle'?
                 }
            }
        };

        startSubscription();

        // Effect cleanup function
        return () => {
            isCancelled = true;
            if (unsub) {
                console.log("[useSubscription] Cleaning up subscription.");
                unsub();
            }
            // Attempt to call iterator.return() for graceful async generator cleanup
            if (iterator && typeof iterator.return === 'function') {
                iterator.return().catch(e => console.warn("[useSubscription] Error during iterator cleanup:", e));
            }
            setUnsubscribeFn(null);
             // Reset status only if effect is cleaning up while potentially active/connecting
             if (status === 'active' || status === 'connecting') {
                  setStatus('idle');
             }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [procedure, inputKey, enabled, client, store]); // Add store to dependencies

    return { status, error, data, unsubscribe: unsubscribeFn };
}