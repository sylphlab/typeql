// packages/react/src/hooks/useQuery.ts
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AnyRouter, TypeQLClientError } from '@sylphlab/typeql-shared';
import { useTypeQL } from '../context'; // Import from the context file

// --- Query Hook ---

// Refined Helper types assuming procedure is client.path.to.procedure
type inferQueryInput<TProcedure> = TProcedure extends { query: (input: infer TInput) => any }
    ? TInput
    : never;

// Inferring output from the promise returned by the query function
type inferQueryOutput<TProcedure> = TProcedure extends { query: (...args: any[]) => Promise<infer TOutput> }
    ? TOutput
    : never;

// Type for query options
/**
 * Options for configuring the useQuery hook.
 * @template TState The type of the state managed by the optimistic store.
 * @template TOutput The expected output type of the query.
 */
export interface UseQueryOptions<TState = any, TOutput = any> { // Add generics
    /**
     * If false, the query will not execute automatically. Defaults to true.
     */
    enabled?: boolean;
    /**
     * Optional function to select the relevant data from the optimistic store's state.
     * Required if using `useQuery` with an `OptimisticStore` where the query output
     * type (`TOutput`) differs from the store's state type (`TState`).
     * @param state The current optimistic state from the store.
     * @returns The selected data corresponding to the query's expected output.
     */
    select?: (state: TState) => TOutput;
    /**
     * The time in milliseconds after data is considered stale. Defaults to 0 (always stale).
     * If set, the data will only be refetched if it is older than the specified time.
     */
    staleTime?: number;
    /**
     * @placeholder The time in milliseconds that unused/inactive cache data remains in memory.
     */
    cacheTime?: number;
    /**
     * @placeholder If set to true, the query will refetch on window focus.
     */
    refetchOnWindowFocus?: boolean;
    // Add other common query options here as needed (e.g., retries)
}

// Type for query result state
/**
 * Represents the state returned by the useQuery hook.
 * @template TOutput The expected output type of the query.
 */
export interface UseQueryResult<TOutput> {
    /**
     * The data returned by the query. Undefined if the query has not completed or has errored.
     */
    data: TOutput | undefined;
    /**
     * True if the query is currently fetching for the first time and has no data yet.
     */
    isLoading: boolean;
    /**
     * True if the query is currently fetching in the background (e.g., refetching).
     */
    isFetching: boolean;
    /**
     * True if the query completed successfully and data is available.
     */
    isSuccess: boolean;
    /**
     * True if the query encountered an error.
     */
    isError: boolean;
    /**
     * The error object if the query failed, otherwise null. Can be a TypeQLClientError or a generic Error.
     */
    error: TypeQLClientError | Error | null;
    /**
     * The current status of the query: 'loading', 'error', or 'success'.
     * Note: 'loading' implies the initial fetch without data. Use `isFetching` for background fetches.
     */
    status: 'loading' | 'error' | 'success';
    /**
     * Function to manually trigger a refetch of the query.
     */
    refetch: () => Promise<void>; // Return promise for better async handling
}


/**
 * Hook to perform a TypeQL query.
 * Automatically fetches data based on the procedure and input.
 * Manages loading, error, and data states.
 *
 * @template TProcedure The type of the TypeQL procedure (e.g., `client.users.get`).
 * @template TInput The inferred input type of the query procedure.
 * @template TOutput The inferred output type of the query procedure.
 * @param procedure The TypeQL query procedure object (e.g., `client.users.get`).
 * @param input The input arguments for the query procedure.
 * @param options Optional configuration for the query behavior, including an optional `select` function if using an optimistic store.
 * @returns An object containing the query state (`data`, `isLoading`, `isFetching`, `isSuccess`, `isError`, `error`, `status`) and a `refetch` function.
 */
export function useQuery<
    TProcedure extends { query: (...args: any[]) => Promise<any> },
    TInput = inferQueryInput<TProcedure>,
    TOutput = inferQueryOutput<TProcedure>,
    TState = any // Add TState generic for store compatibility
>(
    procedure: TProcedure,
    input: TInput,
    options?: UseQueryOptions<TState, TOutput> // Use generic options type
): UseQueryResult<TOutput> {
    const { enabled = true, select, staleTime = 0 } = options ?? {}; // Destructure select and staleTime
    const { client, store } = useTypeQL<AnyRouter, TState>();
    const [data, setData] = useState<TOutput | undefined>(undefined);
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [isFetching, setIsFetching] = useState(false);
    const [status, setStatus] = useState<'loading' | 'error' | 'success'>(enabled ? 'loading' : 'success');
    const lastFetchTimeRef = useRef<number>(0);

    // Refs to hold the latest state values
    const statusRef = useRef(status);
    const dataRef = useRef(data);
    const isFetchingRef = useRef(isFetching);

    const isLoading = status === 'loading' && !data;

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    useEffect(() => {
        statusRef.current = status;
        dataRef.current = data;
        isFetchingRef.current = isFetching;
    }, [status, data, isFetching]);

    const inputKey = useMemo(() => {
        try {
            return JSON.stringify(input);
        } catch {
            console.warn("useQuery: Failed to stringify input for dependency key. Updates may be missed for complex objects.");
            return String(input);
        }
    }, [input]);

    const executeQuery = useCallback(async (
        forceRefetch = false,
        currentData: TOutput | undefined,
        currentStatus: typeof status
    ): Promise<void> => {
        if (!isMountedRef.current || !procedure) return;

        const now = Date.now();
        if (!forceRefetch && currentData !== undefined && staleTime > 0 && (now - lastFetchTimeRef.current < staleTime)) {
            console.log(`[useQuery] Data is fresh (staleTime: ${staleTime}ms). Skipping fetch.`);
            if (currentStatus !== 'success') setStatus('success');
            return;
        }

        console.log('[TEST DEBUG] executeQuery: Entering try block');
        try {
            setIsFetching(true);
            // Only set status to 'loading' if there's no data yet
            if (currentData === undefined && currentStatus !== 'error') {
                 setStatus('loading');
            }
            setError(null);

            console.log('[TEST DEBUG] executeQuery: Calling procedure.query...');
            const result = await procedure.query(input);
            console.log('[TEST DEBUG] executeQuery: procedure.query returned:', result);
            if (isMountedRef.current) {
                console.log('[TEST DEBUG] executeQuery: Component is mounted, attempting success state update...');
                setData(result as TOutput);
                console.log('[TEST DEBUG] executeQuery: Calling setData with:', result);
                if (isMountedRef.current) {
                   setStatus('success');
                   console.log('[TEST DEBUG] executeQuery: Calling setStatus(\'success\')');
                   setError(null);
                   console.log('[TEST DEBUG] executeQuery: Calling setError(null)');
                   lastFetchTimeRef.current = Date.now(); // Update last fetch time ONLY on successful fetch
                   console.log('[TEST DEBUG] executeQuery: Updated lastFetchTimeRef');
                }
            }
        } catch (err: any) {
            console.log('[TEST DEBUG] executeQuery: Entering catch block');
            console.error("[TypeQL React] useQuery Error:", err);
             const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
             if (isMountedRef.current) {
                 console.log('[TEST DEBUG] executeQuery: Component is mounted, attempting error state update...');
                 setError(errorObj);
                 console.log('[TEST DEBUG] executeQuery: Calling setError with:', errorObj);
                 setStatus('error');
                 console.log('[TEST DEBUG] executeQuery: Calling setStatus(\'error\')');
                 setData(undefined);
                 console.log('[TEST DEBUG] executeQuery: Calling setData(undefined)');
             }
        } finally {
             console.log('[TEST DEBUG] executeQuery: Entering finally block');
             if (isMountedRef.current) {
                setIsFetching(false);
                console.log('[TEST DEBUG] executeQuery: Calling setIsFetching(false)');
            }
        }
    }, [procedure, inputKey, staleTime]);

    // Consolidated Effect for Sync, Subscription, and Fetching
    useEffect(() => {
        let isSubscribed = false;
        let unsubscribe = () => {};

        // --- Disabled State ---
        if (!enabled) {
            if (isFetchingRef.current || dataRef.current !== undefined || error !== null) {
                setData(undefined);
                setIsFetching(false);
                setStatus('success'); // Treat as success (idle) when disabled
                setError(null);
            }
            return () => { if (isSubscribed) unsubscribe(); };
        }

        // --- Error State ---
        if (statusRef.current === 'error') {
             return () => { if (isSubscribed) unsubscribe(); };
        }

        // --- Initial Sync & Subscription ---
        let didSync = false;
        if (store) {
            try {
                const currentState = store.getOptimisticState();
                const selectedData = select ? select(currentState) : (currentState as unknown as TOutput);

                if (!select && typeof currentState === 'object' /* ... */) {
                     if (process.env.NODE_ENV !== 'production') console.warn("[useQuery] OptimisticStore provided without a 'select' function...");
                }

                let dataChanged = false;
                if (typeof selectedData === 'object' /* ... */) {
                    dataChanged = JSON.stringify(selectedData) !== JSON.stringify(dataRef.current);
                } else {
                    dataChanged = selectedData !== dataRef.current;
                }

                // Set data if changed or initially undefined, mark that sync happened
                if (dataChanged || dataRef.current === undefined) {
                    setData(selectedData);
                    didSync = true;
                } else if (dataRef.current !== undefined) {
                    // Even if data is the same, treat it as a successful sync for logic below
                    didSync = true;
                }

                const listener = (optimisticState: TState) => {
                    if (isMountedRef.current) {
                        try {
                            const selectedUpdate = select ? select(optimisticState) : (optimisticState as unknown as TOutput);
                            let updateDataChanged = false;
                            if (typeof selectedUpdate === 'object' /* ... */) {
                                updateDataChanged = JSON.stringify(selectedUpdate) !== JSON.stringify(dataRef.current);
                            } else {
                                updateDataChanged = selectedUpdate !== dataRef.current;
                            }
                            if (updateDataChanged) setData(selectedUpdate);
                        } catch (selectErr: any) {
                            console.error("[useQuery] Error selecting state from optimistic update:", selectErr);
                            const errorObj = selectErr instanceof Error ? selectErr : new Error(String(selectErr));
                            setError(errorObj);
                            setStatus('error');
                        }
                   }
                };
                unsubscribe = store.subscribe(listener);
                isSubscribed = true;

            } catch (e) {
                console.error("[useQuery] Error getting/selecting initial optimistic state:", e);
                const syncError = e instanceof Error ? e : new Error(String(e));
                setError(syncError);
                setStatus('error');
                return () => { if (isSubscribed) unsubscribe(); };
            }
        }

        // --- Status Update & Fetching Logic ---
        // If sync happened and status isn't success/fetching, set success
        if (didSync && statusRef.current !== 'success' && !isFetchingRef.current) {
             setStatus('success');
        }

        const now = Date.now();
        const isStale = staleTime === 0 || (now - lastFetchTimeRef.current >= staleTime);
        // Fetch if data is undefined OR if it's stale AND sync didn't just happen
        const needsFetch = dataRef.current === undefined || (isStale && !didSync);

        if (needsFetch) {
            if (!isFetchingRef.current) {
                executeQuery(false, dataRef.current, statusRef.current);
            }
        } else if (!didSync && dataRef.current !== undefined && statusRef.current !== 'success' && !isFetchingRef.current) {
             // If sync didn't happen, but data exists and is fresh, ensure status is success.
             setStatus('success');
        }

        // --- Cleanup ---
        return () => {
            if (isSubscribed) unsubscribe();
        };
    }, [enabled, inputKey, store, select, staleTime, executeQuery]);


    // TODO: Implement refetchOnWindowFocus, cacheTime etc.


    return {
        data,
        isLoading,
        isFetching,
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        status,
        // Pass latest state from refs to executeQuery on manual refetch
        refetch: () => executeQuery(true, dataRef.current, statusRef.current),
    };
}