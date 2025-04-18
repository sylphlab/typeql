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

    // Refetch function - now returns promise
    const executeQuery = useCallback(async (forceRefetch = false): Promise<void> => { // Add forceRefetch flag
        if (!isMountedRef.current || !procedure) return; // Don't fetch if unmounted or procedure missing

        // Check staleTime if not forcing refetch
        const now = Date.now();
        if (!forceRefetch && data !== undefined && staleTime > 0 && (now - lastFetchTimeRef.current < staleTime)) {
            console.log(`[useQuery] Data is fresh (staleTime: ${staleTime}ms). Skipping fetch.`);
            // Ensure status is success if we have data and it's fresh
            if (status !== 'success') setStatus('success');
            return; // Don't fetch if data is fresh
        }

        console.log(`[useQuery] ${forceRefetch ? 'Forcing refetch' : 'Fetching data'}...`);
        setIsFetching(true);
        // Set status to 'loading' only if there's no data yet
        if (!data) {
            setStatus('loading');
        }
        setError(null); // Reset error on new fetch

        try {
            // Assume procedure.query exists and handles input serialization/passing correctly
            const result = await procedure.query(input); // Direct call
            if (isMountedRef.current) {
                setData(result as TOutput); // Assume result is TOutput
                // Check if still mounted before setting state
                if (isMountedRef.current) {
                   setStatus('success');
                   setError(null);
                   lastFetchTimeRef.current = Date.now(); // Update last fetch time on success
                }
            }
            // Resolve the promise on success (no value needed)
        } catch (err: any) {
            console.error("[TypeQL React] useQuery Error:", err);
             const errorObj = err instanceof TypeQLClientError ? err : err instanceof Error ? err : new TypeQLClientError(String(err?.message || err));
             // Check if still mounted before setting state
             if (isMountedRef.current) {
                 setError(errorObj);
                 setStatus('error');
                 // Keep existing data on error, consistent with React Query
             }
             // Reject the promise on error
             throw errorObj; // Rethrow so await caller gets the error
        } finally {
             // Check if still mounted before setting state
             if (isMountedRef.current) {
                setIsFetching(false);
            }
        }
    }, [procedure, inputKey, data, staleTime, status]); // Add data, staleTime, status as dependencies

    useEffect(() => {
        if (enabled) {
            // Initial fetch or refetch based on staleTime
            executeQuery();
        } else {
            // Reset state if disabled
            if (isFetching || data !== undefined || error !== null) {
                setData(undefined);
                setIsFetching(false);
                setStatus('success'); // If disabled, treat as success with no data/error
                setError(null);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, executeQuery]); // Keep dependencies minimal for initial fetch trigger

    // Subscribe to store updates if a store is provided
    useEffect(() => {
        if (!store || !enabled) return; // Only subscribe if store exists and query is enabled

        // Initial data sync if store has state
        if (status !== 'success' && status !== 'loading') { // Only sync if not already loaded/loading
             try {
                 const currentState = store.getOptimisticState();
                 if (select) {
                     setData(select(currentState));
                 } else {
                     // Warn if store is present but no selector and types might mismatch
                     // Basic check: if state is object and output might be primitive/array, warn.
                     // This is imperfect but better than nothing.
                     if (typeof currentState === 'object' && currentState !== null && (typeof data === 'undefined' || typeof data !== 'object')) {
                          if (process.env.NODE_ENV !== 'production') {
                              console.warn("[useQuery] OptimisticStore provided without a 'select' function, and the store state type might differ from the query output type. Direct state usage might lead to errors or unexpected behavior. Consider providing a 'select' function in useQuery options.");
                          }
                     }
                     // Explicitly cast through unknown to acknowledge potential type mismatch
                     setData(currentState as unknown as TOutput);
                 }
                 // Optionally update status if we get initial data from store?
                 // setStatus('success'); // Let's avoid this for now, let fetch determine success
             } catch (e) {
                console.error("[useQuery] Error getting/selecting initial optimistic state:", e);
             }
        }

        const listener = (optimisticState: TState) => {
             if (isMountedRef.current) {
                 try {
                     if (select) {
                         setData(select(optimisticState));
                     } else {
                         // Apply same warning logic as initial sync if applicable
                         if (typeof optimisticState === 'object' && optimisticState !== null && (typeof data === 'undefined' || typeof data !== 'object')) {
                             if (process.env.NODE_ENV !== 'production') {
                                 // Avoid spamming the warning on every update, maybe track if warned already?
                                 // For simplicity, warn only on initial sync for now.
                             }
                         }
                          // Explicitly cast through unknown to acknowledge potential type mismatch
                         setData(optimisticState as unknown as TOutput);
                     }
                     // Don't change fetch status here, this is a background update
                 } catch (selectError: any) {
                     console.error("[useQuery] Error selecting state from optimistic update:", selectError);
                     // Set the hook's error state if selection fails
                     const errorObj = selectError instanceof Error ? selectError : new Error(String(selectError));
                     setError(errorObj);
                     setStatus('error');
                 }
            }
        };

        const unsubscribe = store.subscribe(listener);
        console.log("[useQuery] Subscribed to OptimisticStore updates.");

        // Cleanup subscription on unmount or dependency change
        return () => {
            unsubscribe();
            console.log("[useQuery] Unsubscribed from OptimisticStore updates.");
        };
    }, [store, enabled, status, select, data]); // Add select and data to dependencies

    // TODO: Implement refetchOnWindowFocus, cacheTime etc.


    return {
        data,
        isLoading,
        isFetching,
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        status,
        refetch: () => executeQuery(true), // Pass forceRefetch=true to refetch function
    };
}