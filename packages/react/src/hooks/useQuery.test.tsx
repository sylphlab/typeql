{/* packages/react/src/hooks/useQuery.test.tsx */}
import React, { ReactNode } from 'react'; // Import ReactNode
import { describe, it, expect, vi, beforeEach, afterEach, Mock, afterAll } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'; // Import renderHook
import '@testing-library/jest-dom'; // Ensure matchers are available via setup

// Import hook under test and provider/context
import { useQuery, UseQueryOptions, UseQueryResult } from './useQuery'; // Import hook and types
import { TypeQLProvider } from '../context'; // Import provider
import { createClient, OptimisticStore, StoreListener } from '@sylphlab/typeql-client';
import { TypeQLClientError } from '@sylphlab/typeql-shared'; // Import error type

// --- Mocks ---
const mockTransport = { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn() };
const mockClient = createClient({ transport: mockTransport as any });

const getOptimisticStateMock = vi.fn(); // No default return value here
let capturedStoreListener: StoreListener<any> | null = null;
const subscribeMock = vi.fn((listener: StoreListener<any>) => {
    capturedStoreListener = listener;
    return () => {
        capturedStoreListener = null;
    };
}) as Mock;
const applyServerDeltaMock = vi.fn();
const getConfirmedStateMock = vi.fn(() => ({}));
const getConfirmedServerSeqMock = vi.fn(() => 0);
const getPendingMutationsMock = vi.fn(() => []);
const addPendingMutationMock = vi.fn();
const rejectPendingMutationMock = vi.fn();
const confirmPendingMutationMock = vi.fn();

const mockStore: OptimisticStore<any> = {
    getOptimisticState: getOptimisticStateMock,
    subscribe: subscribeMock,
    applyServerDelta: applyServerDeltaMock,
    getConfirmedState: getConfirmedStateMock,
    getConfirmedServerSeq: getConfirmedServerSeqMock,
    getPendingMutations: getPendingMutationsMock,
    addPendingMutation: addPendingMutationMock,
    rejectPendingMutation: rejectPendingMutationMock,
    confirmPendingMutation: confirmPendingMutationMock,
};

// --- Test Setup ---
describe('useQuery', () => {
    const mockQueryProcedure = { query: vi.fn() };
    const mockInput = { id: 1 };
    const mockOutput = { id: 1, name: 'Test Data' };
    const mockError = new Error('Query Failed');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); // For debugging hook logs

    // Wrapper component providing the context
    const createWrapper = (store: OptimisticStore<any> | undefined = mockStore): React.FC<{ children: ReactNode }> => ({ children }) => (
        <TypeQLProvider client={{ ...mockClient, testQuery: mockQueryProcedure } as any} store={store}>
            {children}
        </TypeQLProvider>
    );

    beforeEach(() => {
      vi.resetAllMocks();
      // Reset mock implementation/return value if needed, but don't set a default here
      getOptimisticStateMock.mockImplementation(() => undefined); // Default to undefined for most tests
      capturedStoreListener = null;
      applyServerDeltaMock.mockClear();
      subscribeMock.mockClear();
      consoleErrorSpy.mockClear();
      consoleWarnSpy.mockClear();
      consoleLogSpy.mockClear();
    });

    afterEach(() => {
        cleanup(); // Cleanup DOM if render was used (less relevant for renderHook)
    });

    afterAll(() => {
        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        consoleLogSpy.mockRestore();
    });

    // --- Tests ---

    it('should initially be in loading state and fetch data', async () => {
      mockQueryProcedure.query.mockResolvedValueOnce(mockOutput); // Use simple resolved value

      const wrapper = createWrapper();
      const { result } = renderHook( // No rerender needed here
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { enabled: true } },
          wrapper,
        }
      );

      // Wait for the status to become success
      await waitFor(() => {
          expect(result.current.status).toBe('success');
          // Optionally check data inside too
          expect(result.current.data).toEqual(mockOutput);
      }, { timeout: 2000 }); // Keep increased timeout

      // Assert final state
      expect(mockQueryProcedure.query).toHaveBeenCalledWith(mockInput); // Ensure query was called
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isFetching).toBe(false);
      expect(result.current.status).toBe('success');
      expect(result.current.data).toEqual(mockOutput);
      expect(result.current.error).toBeNull();
    });

    // TODO: Refactor other tests to use renderHook

    it('should handle query errors', async () => {
      let rejectFetch: (reason?: any) => void;
      const fetchPromise = new Promise((_, reject) => { rejectFetch = reject; });
      mockQueryProcedure.query.mockReturnValueOnce(fetchPromise);

      const wrapper = createWrapper();
      const { result } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { enabled: true } },
          wrapper,
        }
      );

      expect(result.current.status).toBe('loading');
      await waitFor(() => {
          expect(mockQueryProcedure.query).toHaveBeenCalledWith(mockInput);
      });

      await act(async () => {
          rejectFetch(mockError);
          try { await fetchPromise; } catch (e) { /* Ignore rejection */ }
      });
      await act(async () => { await Promise.resolve(); }); // Flush

      await waitFor(() => {
          expect(result.current.status).toBe('error');
      }, { timeout: 2000 });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.isFetching).toBe(false);
      expect(result.current.status).toBe('error');
      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toEqual(mockError);
    });

    it('should handle TypeQLClientError from fetch', async () => {
      const typeqlError = new TypeQLClientError('Fetch Failed Specific');
      let rejectFetch: (reason?: any) => void;
      const fetchPromise = new Promise((_, reject) => { rejectFetch = reject; });
      mockQueryProcedure.query.mockReturnValueOnce(fetchPromise);

      const wrapper = createWrapper();
      const { result } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { enabled: true } },
          wrapper,
        }
      );

      await waitFor(() => {
          expect(mockQueryProcedure.query).toHaveBeenCalledWith(mockInput);
      });

      await act(async () => {
          rejectFetch(typeqlError);
          try { await fetchPromise; } catch (e) { /* Ignore rejection */ }
      });
      await act(async () => { await Promise.resolve(); }); // Flush

      await waitFor(() => {
          expect(result.current.status).toBe('error');
      }, { timeout: 2000 });

      expect(result.current.error).toBeInstanceOf(TypeQLClientError);
      expect(result.current.error).toEqual(typeqlError);
    });


    it('should not fetch if enabled is false', async () => {
      const wrapper = createWrapper();
      const { result } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { enabled: false } },
          wrapper,
        }
      );

      expect(mockQueryProcedure.query).not.toHaveBeenCalled();
      // State should be immediately success if disabled
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isFetching).toBe(false);
      expect(result.current.status).toBe('success');
      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeNull();
    });

    it('should reset state if disabled after successful fetch', async () => {
      let resolveFetch: (value: unknown) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
      mockQueryProcedure.query.mockReturnValueOnce(fetchPromise);

      const wrapper = createWrapper();
      const { result, rerender } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { enabled: true } },
          wrapper,
        }
      );

      // Resolve initial fetch
      await act(async () => {
          resolveFetch(mockOutput);
          await fetchPromise;
      });
      await act(async () => { await Promise.resolve(); }); // Flush

      // Wait for initial success state
      await waitFor(() => {
        expect(result.current.status).toBe('success');
        expect(result.current.data).toEqual(mockOutput);
      }, { timeout: 2000 });

      // Re-render with enabled: false
      rerender({ procedure: mockQueryProcedure, input: mockInput, options: { enabled: false } });

      // Wait for state to reset fully
      await waitFor(() => {
        expect(result.current.isFetching).toBe(false);
        expect(result.current.status).toBe('success'); // Should reset to success (idle)
        expect(result.current.data).toBeUndefined();
        expect(result.current.error).toBeNull();
      });
    });

    it('should fetch when enabled after starting disabled', async () => {
      const wrapper = createWrapper();
      const { result, rerender } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { enabled: false } },
          wrapper,
        }
      );

      // Initial state should be success (idle)
      expect(result.current.status).toBe('success');
      expect(result.current.data).toBeUndefined();
      expect(mockQueryProcedure.query).not.toHaveBeenCalled();

      // Mock the fetch for when it becomes enabled
      let resolveFetch: (value: unknown) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
      mockQueryProcedure.query.mockReturnValueOnce(fetchPromise);

      // Re-render with enabled: true
      rerender({ procedure: mockQueryProcedure, input: mockInput, options: { enabled: true } });

      // Wait for fetching to start
      await waitFor(() => {
        expect(result.current.isFetching).toBe(true);
        expect(result.current.status).toBe('loading');
      });
      expect(mockQueryProcedure.query).toHaveBeenCalledTimes(1);

      // Resolve the fetch
      await act(async () => {
          resolveFetch(mockOutput);
          await fetchPromise;
      });
      await act(async () => { await Promise.resolve(); }); // Flush

      // Wait for final success state
      await waitFor(() => {
        expect(result.current.status).toBe('success');
        expect(result.current.data).toEqual(mockOutput);
        expect(result.current.isFetching).toBe(false);
      }, { timeout: 2000 });
    });


    it('should reset state if disabled while fetching', async () => {
      let resolveFetch: any;
      const fetchingPromise = new Promise((resolve) => { resolveFetch = resolve; });
      mockQueryProcedure.query.mockReturnValue(fetchingPromise); // Keep returning promise

      const wrapper = createWrapper();
      const { result, rerender } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { enabled: true } },
          wrapper,
        }
      );

      await waitFor(() => {
        expect(result.current.isFetching).toBe(true);
        expect(result.current.status).toBe('loading');
      });

      // Re-render with enabled: false
      rerender({ procedure: mockQueryProcedure, input: mockInput, options: { enabled: false } });

      // Wait for state to reset fully
      await waitFor(() => {
        expect(result.current.isFetching).toBe(false);
        expect(result.current.status).toBe('success');
      });

      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeNull();

      // Clean up promise
      resolveFetch?.(mockOutput);
    });


    it('should allow manual refetching', async () => {
      let resolveFetch1: (value: unknown) => void;
      const fetchPromise1 = new Promise((resolve) => { resolveFetch1 = resolve; });
      let resolveFetch2: (value: unknown) => void;
      const fetchPromise2 = new Promise((resolve) => { resolveFetch2 = resolve; });
      mockQueryProcedure.query
        .mockReturnValueOnce(fetchPromise1)
        .mockReturnValueOnce(fetchPromise2);

      const wrapper = createWrapper();
      const { result } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { enabled: true } },
          wrapper,
        }
      );

      // Initial fetch
      await act(async () => {
          resolveFetch1(mockOutput);
          await fetchPromise1;
      });
      await act(async () => { await Promise.resolve(); }); // Flush

      await waitFor(() => {
          expect(result.current.status).toBe('success');
          expect(result.current.data).toEqual(mockOutput);
      }, { timeout: 2000 });
      expect(mockQueryProcedure.query).toHaveBeenCalledTimes(1);

      // Refetch
      const refetchOutput = { id: 1, name: 'Updated Data' };
      act(() => {
          result.current.refetch(); // Trigger refetch
      });

      // Wait for fetching state during refetch
      await waitFor(() => {
          expect(result.current.isFetching).toBe(true);
      });
      expect(mockQueryProcedure.query).toHaveBeenCalledTimes(2);

      // Resolve second fetch
      await act(async () => {
          resolveFetch2(refetchOutput);
          await fetchPromise2;
      });
      await act(async () => { await Promise.resolve(); }); // Flush

      // Wait for state update after refetch
      await waitFor(() => {
          expect(result.current.status).toBe('success');
          expect(result.current.data).toEqual(refetchOutput);
          expect(result.current.isFetching).toBe(false); // Ensure fetching is false
      }, { timeout: 2000 });

      expect(result.current.isFetching).toBe(false);
      expect(result.current.status).toBe('success');
      expect(result.current.data).toEqual(refetchOutput);
    });

    it('should get initial data from store if available and select is provided', async () => {
        const initialStoreState = { items: { '1': mockOutput } };
        getOptimisticStateMock.mockReturnValue(initialStoreState);
        const selectFn = vi.fn((state: typeof initialStoreState) => state.items['1']);

        const wrapper = createWrapper();
        const { result } = renderHook(
          ({ procedure, input, options }) => useQuery(procedure, input, options),
          {
            initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { select: selectFn } },
            wrapper,
          }
        );

        // Wait for the initial state derived from the store/select to stabilize
        await waitFor(() => {
            expect(result.current.data).toEqual(mockOutput);
            expect(result.current.status).toBe('success');
        }, { timeout: 2000 });

        // Assert state after sync/fetch settles
        expect(selectFn).toHaveBeenCalledWith(initialStoreState);
        expect(result.current.isLoading).toBe(false);
        // Note: With staleTime 0 (default), a background fetch might still be triggered
        // We check isFetching might be true initially after sync
        // await waitFor(() => expect(result.current.isFetching).toBe(false)); // Optional: wait if fetch happens
    });

    it('should refetch if initial data from store is considered stale (staleTime: 0)', async () => {
        const initialStoreState = { items: { '1': mockOutput } };
        getOptimisticStateMock.mockReturnValue(initialStoreState);
        const selectFn = vi.fn((state: typeof initialStoreState) => state.items['1']);
        const networkOutput = { id: 1, name: 'Network Data' };

        let resolveFetch: (value: unknown) => void;
        const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
        mockQueryProcedure.query.mockReturnValueOnce(fetchPromise);

        const wrapper = createWrapper();
        const { result } = renderHook(
          ({ procedure, input, options }) => useQuery(procedure, input, options),
          {
            initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { select: selectFn, staleTime: 0 } },
            wrapper,
          }
        );

        // Initial state should reflect store data, but fetching should start
        expect(result.current.data).toEqual(mockOutput);
        expect(result.current.status).toBe('loading'); // Or success depending on timing, check isFetching
        await waitFor(() => expect(result.current.isFetching).toBe(true));
        expect(mockQueryProcedure.query).toHaveBeenCalledTimes(1);

        // Resolve the fetch
        await act(async () => {
            resolveFetch(networkOutput);
            await fetchPromise;
        });
        await act(async () => { await Promise.resolve(); }); // Flush

        // Wait for the data to update to network output
        await waitFor(() => {
            expect(result.current.data).toEqual(networkOutput);
            expect(result.current.status).toBe('success');
        }, { timeout: 2000 });

        expect(result.current.isFetching).toBe(false);
    });

     it('should not refetch if initial data from store is fresh (staleTime: 60s)', async () => {
         const initialStoreState = { items: { '1': mockOutput } };
         getOptimisticStateMock.mockReturnValue(initialStoreState);
         const selectFn = vi.fn((state: typeof initialStoreState) => state.items['1']);

         const wrapper = createWrapper();
         const { result } = renderHook(
           ({ procedure, input, options }) => useQuery(procedure, input, options),
           {
             initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { select: selectFn, staleTime: 60 * 1000 } },
             wrapper,
           }
         );

         // Wait for initial state from store
         await waitFor(() => {
             expect(result.current.data).toEqual(mockOutput);
             expect(result.current.status).toBe('success');
             expect(selectFn).toHaveBeenCalledWith(initialStoreState);
         }, { timeout: 2000 });

         // Assert initial state after waiting
         expect(result.current.isLoading).toBe(false);
         expect(result.current.isFetching).toBe(false); // Should be false as data is fresh

         // Wait a short time to ensure no fetch is triggered
         await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });

         // Expect query *not* to have been called because data is fresh
         expect(mockQueryProcedure.query).not.toHaveBeenCalled();
         expect(result.current.isFetching).toBe(false); // Still not fetching
     });

     it('should handle errors in select function during initial load', async () => {
        const initialStoreState = { items: { '1': mockOutput } };
        getOptimisticStateMock.mockReturnValue(initialStoreState);
        const selectError = new Error('Select Failed');
        const selectFn = vi.fn((state: typeof initialStoreState) => { throw selectError; });

        const wrapper = createWrapper();
        const { result } = renderHook(
          ({ procedure, input, options }) => useQuery(procedure, input, options),
          {
            initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { select: selectFn } },
            wrapper,
          }
        );

        // Wait for the console error and error status
        await waitFor(() => {
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "[useQuery] Error getting/selecting initial optimistic state:",
                selectError
            );
            expect(result.current.status).toBe('error');
            expect(result.current.error).toEqual(selectError);
        }, { timeout: 2000 });

        // Assert final state
        expect(result.current.status).toBe('error');
        expect(result.current.error).toEqual(selectError);
        expect(result.current.data).toBeUndefined();
        expect(result.current.isFetching).toBe(false);
    });

    it('should handle errors in select function during store update', async () => {
        const initialData = { id: 1, name: 'Initial Fetch Data' };
        let resolveFetch: (value: unknown) => void;
        const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
        mockQueryProcedure.query.mockReturnValueOnce(fetchPromise);

        const selectError = new Error('Select Failed During Update');
        const selectFn = vi.fn()
            .mockImplementationOnce((state: any) => state?.items?.['1'] ?? initialData) // Initial select (or from fetch)
            .mockImplementation(() => { throw selectError; }); // Subsequent call throws

        const wrapper = createWrapper();
        const { result } = renderHook(
          ({ procedure, input, options }) => useQuery(procedure, input, options),
          {
            initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { select: selectFn } },
            wrapper,
          }
        );

        // Resolve initial fetch
        await act(async () => {
            resolveFetch(initialData);

            await fetchPromise;
        });
        await act(async () => { await Promise.resolve(); }); // Flush

        // Wait for initial state
        await waitFor(() => {
            expect(result.current.status).toBe('success');
            expect(result.current.data).toEqual(initialData);
        }, { timeout: 2000 });
        expect(subscribeMock).toHaveBeenCalled(); // Ensure subscription happened

        // Simulate store update triggering the listener which will throw error
        const storeUpdateState = { items: { '1': { ...mockOutput, name: "Updated Store Data" } } };
        act(() => {
            expect(capturedStoreListener).toBeInstanceOf(Function);
            if (capturedStoreListener) {
                capturedStoreListener(storeUpdateState, {});
            }
        });

        // Wait for the error state
        await waitFor(() => {
             expect(result.current.status).toBe('error');
             expect(result.current.error).toEqual(selectError);
        }, { timeout: 2000 });

        // Assert final state
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            "[useQuery] Error selecting state from optimistic update:",
            selectError
        );
        expect(result.current.error).toEqual(selectError);
        expect(result.current.status).toBe('error');
    });

    it('should handle TypeQLClientError in select function during store update', async () => {
        const initialData = { id: 1, name: 'Initial Fetch Data' };
        let resolveFetch: (value: unknown) => void;
        const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
        mockQueryProcedure.query.mockReturnValueOnce(fetchPromise);

        const selectError = new TypeQLClientError('Select Failed Specific');
        const selectFn = vi.fn()
            .mockImplementationOnce((state: any) => state?.items?.['1'] ?? initialData) // Initial select
            .mockImplementation(() => { throw selectError; }); // Subsequent call throws

        const wrapper = createWrapper();
        const { result } = renderHook(
          ({ procedure, input, options }) => useQuery(procedure, input, options),
          {
            initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { select: selectFn } },
            wrapper,
          }
        );

        // Resolve initial fetch
        await act(async () => {
            resolveFetch(initialData);
            await fetchPromise;
        });
        await act(async () => { await Promise.resolve(); }); // Flush

        await waitFor(() => {
            expect(result.current.status).toBe('success');
        }, { timeout: 2000 });
        expect(subscribeMock).toHaveBeenCalled();

        // Simulate store update
        const storeUpdateState = { items: { '1': { ...mockOutput, name: "Updated Store Data" } } };
        act(() => {
            if (capturedStoreListener) capturedStoreListener(storeUpdateState, {});
        });

        // Wait for the error state
        await waitFor(() => {
             expect(result.current.status).toBe('error');
             expect(result.current.error).toBeInstanceOf(TypeQLClientError);
             expect(result.current.error).toEqual(selectError);
        }, { timeout: 2000 });
    });

    // Skipping potentially flaky tests from Preact version
    it.skip('should skip refetch if already fetching', () => {});
    it.skip('should reset state if disabled while fetching', () => {});

    it('should handle input serialization error and warn', () => {
        const circularInput: any = { id: 1 };
        circularInput.self = circularInput;

        const wrapper = createWrapper();
        renderHook(
          ({ procedure, input, options }) => useQuery(procedure, input, options),
          {
            initialProps: { procedure: mockQueryProcedure, input: circularInput, options: {} },
            wrapper,
          }
        );

        expect(consoleWarnSpy).toHaveBeenCalledWith(
            "useQuery: Failed to stringify input for dependency key. Updates may be missed for complex objects."
        );
    });

    it('should warn if store provided without select and types might mismatch', async () => {
      const initialStoreState = { someData: { id: 1, value: 'abc' } };
      getOptimisticStateMock.mockReturnValue(initialStoreState);
      const mockPrimitiveOutput = 123;

      let resolveFetch: (value: unknown) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
      mockQueryProcedure.query.mockReturnValueOnce(fetchPromise);

      const wrapper = createWrapper(); // Use default mockStore
      const { result } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          initialProps: { procedure: mockQueryProcedure, input: mockInput, options: { select: undefined } },
          wrapper,
        }
      );

      // Resolve fetch
      await act(async () => {
          resolveFetch(mockPrimitiveOutput);
          await fetchPromise;
      });
      await act(async () => { await Promise.resolve(); }); // Flush

      // Wait for the warning and the fetch to complete (status success)
      await waitFor(() => {
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[useQuery] OptimisticStore provided without a 'select' function")
        );
        expect(result.current.status).toBe('success'); // Wait for final status
      }, { timeout: 2000 });

      // Assert final state
      expect(result.current.data).toEqual(mockPrimitiveOutput);
      expect(result.current.status).toBe('success');
    });

    // Test added for coverage - Refactored for renderHook
    it('should update timestamp but not data during initial sync if store data matches existing data', async () => {
      // 1. Initial fetch to populate data
      let resolveFetch1: (value: unknown) => void;
      const fetchPromise1 = new Promise((resolve) => { resolveFetch1 = resolve; });
      mockQueryProcedure.query.mockReturnValueOnce(fetchPromise1);

      const wrapper = createWrapper(); // Use default store initially
      const { result, rerender } = renderHook(
        ({ procedure, input, options }) => useQuery(procedure, input, options),
        {
          // Explicitly type initialProps to allow optional select
          initialProps: {
            procedure: mockQueryProcedure,
            input: mockInput,
            options: { staleTime: 60000 } as UseQueryOptions<any, any> // Type options, select is optional
          },
          wrapper,
        }
      );

      // Resolve first fetch
      await act(async () => {
          resolveFetch1(mockOutput);
          await fetchPromise1;
      });
      await act(async () => { await Promise.resolve(); }); // Flush

      let stateAfterFetch: UseQueryResult<any> | undefined;
      await waitFor(() => {
        expect(result.current.status).toBe('success');
        expect(result.current.data).toEqual(mockOutput);
        stateAfterFetch = result.current; // Capture state
      }, { timeout: 2000 });
      expect(mockQueryProcedure.query).toHaveBeenCalledTimes(1);
      expect(stateAfterFetch).toBeDefined();

      // 2. Mock store to return the same data and setup select
      const initialStoreState = { items: { '1': mockOutput } }; // Same data as fetched
      getOptimisticStateMock.mockReturnValue(initialStoreState);
      const selectFn = vi.fn((state: typeof initialStoreState) => state.items['1']);

      // 3. Re-render with the select function, triggering the initial sync effect again
      // Let TS infer the options type for rerender
      rerender({ procedure: mockQueryProcedure, input: mockInput, options: { select: selectFn, staleTime: 60000 } });

      // 4. Wait for the sync effect to run
      await waitFor(() => {
        // Select should be called by the sync effect
        expect(selectFn).toHaveBeenCalledWith(initialStoreState);
        // Status should remain success
        expect(result.current.status).toBe('success');
      }, { timeout: 2000 });

      // 5. Assertions
      expect(result.current.data).toBe(stateAfterFetch!.data); // Data reference should be the same
      expect(result.current.isFetching).toBe(false); // Should not fetch again
    });

}); // End of useQuery describe
