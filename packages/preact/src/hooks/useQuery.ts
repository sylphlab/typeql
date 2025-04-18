// packages/preact/src/hooks/useQuery.ts
import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
import {
    AnyRouter,
    TypeQLClientError,
} from '@sylphlab/typeql-shared';
import { useTypeQL } from '../context'; // Import from context file

// --- Query Hook ---

// Helper types assuming procedure is client.path.to.procedure
type inferQueryInput<TProcedure> = TProcedure extends { query: (input: infer TInput) => any }
    ? TInput
    : never;

// Inferring output from the promise returned by the query function
type inferQueryOutput<TProcedure> = TProcedure extends { query: (...args: any[]) => Promise<infer TOutput> }
    ? TOutput
    : never;

// Type for query options
export interface UseQueryOptions<TState = any, TOutput = any> {
    enabled?: boolean;
    select?: (state: TState) => TOutput;
    staleTime?: number;
    cacheTime?: number; // Placeholder
    refetchOnWindowFocus?: boolean; // Placeholder
}

// Type for query result state
export interface UseQueryResult<TOutput> {
    data: TOutput | undefined;
    isLoading: boolean;
    isFetching: boolean;
    isSuccess: boolean;
    isError: boolean;
    error: TypeQLClientError | Error | null;
    status: 'loading' | 'error' | 'success';
    refetch: () => Promise<void>;
}

export function useQuery<
    TProcedure extends { query: (...args: any[]) => Promise<any> },
    TInput = inferQueryInput<TProcedure>,
    TOutput = inferQueryOutput<TProcedure>,
    TState = any
>(
    procedure: TProcedure,
    input: TInput,
    options?: UseQueryOptions<TState, TOutput>
): UseQueryResult<TOutput> {
    const { enabled = true, select, staleTime = 0 } = options ?? {};
    const { client, store } = useTypeQL<AnyRouter, TState>();

    const getInitialData = useCallback((): TOutput | undefined => {
        if (store && enabled) {
            try {
                const currentState = store.getOptimisticState();
                return select ? select(currentState) : (currentState as unknown as TOutput);
            } catch (e) {
                console.error("[useQuery] Error getting/selecting initial optimistic state for useState:", e);
            }
        }
        return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [store, enabled, select]);

    const [data, setData] = useState<TOutput | undefined>(getInitialData);
    const [error, setError] = useState<TypeQLClientError | Error | null>(null);
    const initialStatus = data !== undefined ? 'success' : (enabled ? 'loading' : 'success');
    const [status, setStatus] = useState<'loading' | 'error' | 'success'>(initialStatus);
    // isFetching state needs careful initialization and updates
    const [isFetching, setIsFetching] = useState(enabled && data === undefined);
    const lastFetchTimeRef = useRef<number>(data !== undefined ? Date.now() : 0);

    const isLoading = status === 'loading';

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const inputKey = useMemo(() => {
        try {
            return JSON.stringify(input);
        } catch {
            console.warn("useQuery: Failed to stringify input for dependency key. Updates may be missed for complex objects.");
            return String(input);
        }
    }, [input]);

    const executeQuery = useCallback(async (forceRefetch = false): Promise<void> => {
        if (!isMountedRef.current || !procedure) return;

        const now = Date.now();
        const isDataStale = data === undefined || staleTime <= 0 || (now - lastFetchTimeRef.current >= staleTime);

        if (!forceRefetch && !isDataStale) {
            console.log(`[useQuery] Data is fresh (staleTime: ${staleTime}ms). Skipping fetch.`);
            if (status !== 'success') setStatus('success'); // Ensure status is success if data is fresh
            return;
        }
        if (!enabled) {
            console.log(`[useQuery] Query is disabled. Skipping fetch.`);
            return;
        }

        console.log(`[useQuery] ${forceRefetch ? 'Forcing refetch' : isDataStale ? 'Fetching stale data' : 'Fetching data'}...`);
        if (data === undefined && status !== 'loading') { // Only set loading if not already loading
            setStatus('loading');
        }

        let hadError = false; // Flag to prevent finally block from setting isFetching false on error
        try {
             if (isFetching && !forceRefetch) { // Check moved inside try
                 console.log("[useQuery] Already fetching. Skipping.");
                 return;
             }
            setIsFetching(true); // Moved inside try
            const queryResult = await procedure.query(input) as TOutput;

            if (isMountedRef.current) {
                setData(queryResult);
                setStatus('success');
                setError(null);
                lastFetchTimeRef.current = Date.now();
            }
        } catch (err: any) {
            hadError = true; // Mark error occurred
            console.error("[TypeQL Preact] useQuery Error:", err);
            if (isMountedRef.current) {
                setError(err instanceof TypeQLClientError ? err :
                       err instanceof Error ? err :
                       new TypeQLClientError(String(err?.message || err)));
                setStatus('error');
                setData(undefined); // Reset data on error
                setIsFetching(false); // Set fetching false on error
            }
        } finally {
            // Only set isFetching false if mounted and no error occurred during this fetch attempt
            if (isMountedRef.current && !hadError) {
                setIsFetching(false);
            }
        }
    }, [procedure, inputKey, staleTime, enabled, data, status, isFetching]); // Added data, status, isFetching dependencies

    useEffect(() => {
        if (enabled) {
            void executeQuery();
        } else {
             // Reset state if disabled
             setData(undefined);
             // setIsFetching(false); // Moved to cleanup effect
             setStatus('success');
             setError(null);
             lastFetchTimeRef.current = 0;
        }
    }, [enabled, inputKey, procedure, executeQuery]);

     useEffect(() => {
         return () => {
              if (isMountedRef.current) {
                  setIsFetching(false); // Ensure reset on cleanup
              }
         };
     // eslint-disable-next-line react-hooks/exhaustive-deps
     }, [enabled, inputKey, procedure]);

    const storeListener = useCallback((optimisticState: TState, confirmedState: TState) => {
        if (isMountedRef.current && !isFetching) { // Check isFetching
            try {
                if (select) {
                    setData(select(optimisticState));
                } else {
                    setData(optimisticState as unknown as TOutput);
                }
                if (status !== 'success') setStatus('success');
            } catch (e) {
                console.error("[useQuery] Error selecting state from optimistic update:", e);
            }
       }
   }, [select, status, isFetching]); // Added isFetching dependency

    useEffect(() => {
        if (!store || !enabled) return;
        const unsubscribe = store.subscribe(storeListener);
        console.log("[useQuery] Subscribed to OptimisticStore updates.");
        return () => {
            unsubscribe();
            console.log("[useQuery] Unsubscribed from OptimisticStore updates.");
        };
    }, [store, enabled, storeListener]);

    return {
        data,
        isLoading,
        isFetching,
        isSuccess: status === 'success',
        isError: status === 'error',
        error,
        status,
        refetch: () => executeQuery(true),
    };
}