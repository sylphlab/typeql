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
    // Use the new hook to get client and potentially store, specifying TState
    const { client, store } = useTypeQL<AnyRouter, TState>();
    const [data, setData] = useState<TOutput | undefined>(undefined);
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const [isFetching, setIsFetching] = useState(false); // Start as false, set true in executeQuery
    const [status, setStatus] = useState<'loading' | 'error' | 'success'>(enabled ? 'loading' : 'success'); // Initial status depends on enabled
    const lastFetchTimeRef = useRef<number>(0); // Ref to store the timestamp of the last successful fetch

    const isLoading = status === 'loading' && !data; // More direct derivation

    // Use ref to manage mounted state and prevent state updates after unmount
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    // Serialize input for dependency array - basic JSON stringify, acknowledge limitations
    // Consider libraries like 'fast-json-stable-stringify' or deep comparison for complex inputs
    const inputKey = useMemo(() => {
        try {
            // Use a stable stringifier if available, otherwise fallback
            return JSON.stringify(input);
        } catch {
            console.warn("useQuery: Failed to stringify input for dependency key. Updates may be missed for complex objects.");
            return String(input); // Basic fallback
        }
    }, [input]);

    // Refetch function - now returns promise, accepts current state
    const executeQuery = useCallback(async (
        forceRefetch = false,
        currentData: TOutput | undefined, // Pass current data
        currentStatus: typeof status // Pass current status
    ): Promise<void> => {
        if (!isMountedRef.current || !procedure) return; // Don't fetch if unmounted or procedure missing

        // Check staleTime if not forcing refetch, using passed state
        const now = Date.now();
        if (!forceRefetch && currentData !== undefined && staleTime > 0 && (now - lastFetchTimeRef.current < staleTime)) {
            console.log(`[useQuery] Data is fresh (staleTime: ${staleTime}ms). Skipping fetch.`);
            // Ensure status is success if we have data and it's fresh
            if (currentStatus !== 'success') setStatus('success'); // Use currentStatus for check, setStatus updates state
            return; // Don't fetch if data is fresh
        }

        // console.log(`[useQuery] ${forceRefetch ? 'Forcing refetch' : 'Fetching data'}...`); // Removed due to test loop
        // Moved state updates inside try block, after stale check passes

            console.log('[TEST DEBUG] executeQuery: Entering try block');
        try {
            // Only set fetching/loading state if we are actually going to fetch
            setIsFetching(true);
            if (currentStatus !== 'error') {
                 setStatus('loading');
            }
            setError(null); // Reset error only when attempting a new fetch

            // Assume procedure.query exists and handles input serialization/passing correctly
            console.log('[TEST DEBUG] executeQuery: Calling procedure.query...');
            const result = await procedure.query(input); // Direct call
            console.log('[TEST DEBUG] executeQuery: procedure.query returned:', result);
            if (isMountedRef.current) {
            if (isMountedRef.current) console.log('[TEST DEBUG] executeQuery: Component is mounted, attempting success state update...');
                setData(result as TOutput); // Assume result is TOutput
                console.log('[TEST DEBUG] executeQuery: Calling setData with:', result);
                // Check if still mounted before setting state
                if (isMountedRef.current) {
                   setStatus('success');
                   console.log('[TEST DEBUG] executeQuery: Calling setStatus(\'success\')');
                   setError(null);
                   console.log('[TEST DEBUG] executeQuery: Calling setError(null)');
                   lastFetchTimeRef.current = Date.now(); // Update last fetch time on success
                }
                   console.log('[TEST DEBUG] executeQuery: Updated lastFetchTimeRef');
            }
            // Resolve the promise on success (no value needed)
        } catch (err: any) {
            console.log('[TEST DEBUG] executeQuery: Entering catch block');
            console.error("[TypeQL React] useQuery Error:", err);
             const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
             // Check if still mounted before setting state
             if (isMountedRef.current) {
             if (isMountedRef.current) console.log('[TEST DEBUG] executeQuery: Component is mounted, attempting error state update...');
                 setError(errorObj);
                 console.log('[TEST DEBUG] executeQuery: Calling setError with:', errorObj);
                 setStatus('error');
                 console.log('[TEST DEBUG] executeQuery: Calling setStatus(\'error\')');
                 setData(undefined); // Clear data on error to match test expectation
             }
                 console.log('[TEST DEBUG] executeQuery: Calling setData(undefined)');
             // Reject the promise on error
             // throw errorObj; // Removed: Error is captured in state, no need to re-throw
        } finally {
             // Check if still mounted before setting state
            console.log('[TEST DEBUG] executeQuery: Entering finally block');
             if (isMountedRef.current) {
                setIsFetching(false);
                console.log('[TEST DEBUG] executeQuery: Calling setIsFetching(false)');
            }
        }
    // Dependencies remain stable: procedure, inputKey, staleTime
    }, [procedure, inputKey, staleTime]);

    // Effect for Fetching Data (Handles initial fetch if needed)
    useEffect(() => {
        let isEffectActive = true; // Flag to prevent state updates after cleanup

        if (enabled && status !== 'error') {
            // Determine if fetch is needed based on current data and staleness
            const now = Date.now();
            const isStale = staleTime === 0 || (now - lastFetchTimeRef.current >= staleTime);
            const needsFetch = data === undefined || isStale; // Fetch if no data or if stale

            if (needsFetch) {
                executeQuery(false, data, status);
            } else if (data !== undefined && status !== 'success') {
                 // Data exists and is fresh, but status isn't success yet (e.g., after initial sync)
                 // Ensure status becomes success if not already loading/fetching
                 if (!isFetching) {
                     setStatus('success');
                 }
            }
        } else if (!enabled) {
            // Reset state if disabled
            if (isFetching || data !== undefined || error !== null) {
                setData(undefined);
                setIsFetching(false);
                setStatus('success'); // Treat as success with no data/error
                setError(null);
            }
        }

        return () => { isEffectActive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, inputKey, status]); // Reverted: Removed executeQuery, added eslint disable

    // Effect for Store Subscription and Initial Sync
    useEffect(() => {
        if (!store || !enabled) return; // Only subscribe if store exists and query is enabled

        let initialSyncError: Error | null = null;
        let isSubscribed = false;
        let unsubscribe = () => {};

        try {
            // --- Initial Sync ---
            const currentState = store.getOptimisticState();
            const selectedData = select ? select(currentState) : (currentState as unknown as TOutput);

            // Warn if needed
            if (!select && typeof currentState === 'object' /* ... rest of warning check */) {
                 if (process.env.NODE_ENV !== 'production') console.warn("[useQuery] OptimisticStore provided without a 'select' function...");
            }

            let dataChanged = false;
            if (typeof selectedData === 'object' /* ... rest of comparison */) {
                dataChanged = JSON.stringify(selectedData) !== JSON.stringify(data);
            } else {
                dataChanged = selectedData !== data;
            }

            // Update data and timestamp if changed or initially undefined
            if (dataChanged || data === undefined) {
                 setData(selectedData);
                 lastFetchTimeRef.current = Date.now(); // Treat store data as fresh initially
            } else if (data !== undefined) {
                 // Data exists and matches store, just update timestamp
                 lastFetchTimeRef.current = Date.now(); // Also update if data was already correct
            }
            // --- End Initial Sync ---

        } catch (e) {
            console.error("[useQuery] Error getting/selecting initial optimistic state:", e);
            initialSyncError = e instanceof Error ? e : new Error(String(e));
            setError(initialSyncError);
            setStatus('error'); // Set error status on sync failure
            // Don't subscribe if initial sync failed
            return;
        }

        // --- Setup Listener (only if sync didn't error) ---
        const listener = (optimisticState: TState) => {
             if (isMountedRef.current) {
                 try {
                     const selectedUpdate = select ? select(optimisticState) : (optimisticState as unknown as TOutput);
                     let updateDataChanged = false;
                     if (typeof selectedUpdate === 'object' /* ... */) {
                         updateDataChanged = JSON.stringify(selectedUpdate) !== JSON.stringify(data);
                     } else {
                         updateDataChanged = selectedUpdate !== data;
                     }
                     if (updateDataChanged) setData(selectedUpdate);
                 } catch (selectError: any) {
                     console.error("[useQuery] Error selecting state from optimistic update:", selectError);
                     const errorObj = selectError instanceof Error ? selectError : new Error(String(selectError));
                     setError(errorObj);
                     setStatus('error');
                 }
            }
        };
        unsubscribe = store.subscribe(listener);
        isSubscribed = true;

        // --- Cleanup ---
        return () => {
            if (isSubscribed) unsubscribe();
        };
        // Dependencies: Only re-run if store, enabled status, or select function changes.
    }, [store, enabled, select, data]); // Add `data` dependency for comparison logic

    // TODO: Implement refetchOnWindowFocus, cacheTime etc.


    return {
        data,
        isLoading,
        isFetching,
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        status,
        // Pass current state to executeQuery on manual refetch
        refetch: () => executeQuery(true, data, status),
    };
}