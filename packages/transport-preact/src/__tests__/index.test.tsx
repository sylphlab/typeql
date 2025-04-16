// packages/transport-preact/src/__tests__/index.test.tsx

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { TypeQLProvider, useTypeQL, useQuery, useMutation, useSubscription } from '../index'; // Adjust path as needed
import {
    createClient,
    createRouter,
    TypeQLTransport,
    AnyRouter,
    SubscriptionDataMessage,
    SubscriptionErrorMessage,
    UnsubscribeFn,
    MutationCallOptions, // Import for mutate mock
} from '@typeql/core'; // Import necessary core parts, including AnyRouter

// Mock Transport
const mockTransport: TypeQLTransport = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    // 'on' method likely removed from interface
    request: vi.fn(),
    subscribe: vi.fn(() => ({ iterator: (async function*() {})(), unsubscribe: vi.fn() })), // Mock subscribe
};

// Mock Router and Client
const mockRouter = createRouter(); // createRouter now takes no arguments
// Use AnyRouter for mock client type as specific router type isn't needed for this test
const mockClient = createClient<AnyRouter>({ transport: mockTransport });

// --- Mock Procedures ---
// We need to define mock procedures on the client object for the hooks to call
const mockProcedures = {
    testQuery: {
        query: vi.fn(),
    },
    testMutation: {
        mutate: vi.fn(),
    },
    testSubscription: {
        subscribe: vi.fn(),
    },
};

// Assign mock procedures to the client (casting to any to bypass type checking for mocks)
(mockClient as any).testQuery = mockProcedures.testQuery;
(mockClient as any).testMutation = mockProcedures.testMutation;
(mockClient as any).testSubscription = mockProcedures.testSubscription;


// Test Component using the hook
const TestComponent = () => {
    try {
        const { client } = useTypeQL();
        expect(client).toBeDefined();
        expect(client).toBe(mockClient); // Check if the correct client instance is passed
        return h('div', null, 'Hook works');
    } catch (error: any) {
        return h('div', null, `Hook failed: ${error.message}`);
    }
};

// Test Component outside provider
const TestComponentOutside = () => {
    try {
        useTypeQL();
        return h('div', null, 'Hook should fail');
    } catch (error: any) {
        return h('div', null, `Hook failed as expected: ${error.message}`);
    }
};

describe('Preact Hooks', () => {
    // Reset mocks before each test in this suite
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset procedure mocks specifically
        mockProcedures.testQuery.query.mockReset();
        mockProcedures.testMutation.mutate.mockReset();
        mockProcedures.testSubscription.subscribe.mockReset();
    });

    it('useTypeQL should return client when used within Provider', () => {
        const { container } = render(
            // Explicitly pass children in props as well to satisfy TS/h interaction
            h(TypeQLProvider, { client: mockClient, children: h(TestComponent, null) })
        );
        expect(container.textContent).toBe('Hook works');
    }); // End it block

    it('useTypeQL should throw error when used outside Provider', () => {
        // Suppress console.error for this specific test if needed
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { container } = render(h(TestComponentOutside, null));

        expect(container.textContent).toContain('Hook failed as expected: `useTypeQL` must be used within a `TypeQLProvider`.');

        consoleErrorSpy.mockRestore(); // Restore console.error
    }); // End it block

    // --- useQuery Tests ---
    describe('useQuery', () => {
        const QueryComponent = ({ input, options }: { input: any, options?: any }) => {
            // Cast the mocked procedure to the type expected by useQuery
            const procedure = mockClient.testQuery as { query: (...args: any[]) => Promise<any> };
            const { data, isLoading, isFetching, isSuccess, isError, error, status, refetch } = useQuery(
                procedure,
                input,
                options
            );
            return h('div', null, [
                h('span', { 'data-testid': 'status' }, status),
                h('span', { 'data-testid': 'isLoading' }, String(isLoading)),
                h('span', { 'data-testid': 'isFetching' }, String(isFetching)),
                h('span', { 'data-testid': 'isSuccess' }, String(isSuccess)),
                h('span', { 'data-testid': 'isError' }, String(isError)),
                h('span', { 'data-testid': 'data' }, data ? JSON.stringify(data) : 'undefined'),
                h('span', { 'data-testid': 'error' }, error ? error.message : 'null'),
                h('button', { 'data-testid': 'refetch', onClick: refetch }, 'Refetch'),
            ]);
        };

        it('should fetch data successfully', async () => {
            const mockData = { id: 1, name: 'Test Data' };
            mockProcedures.testQuery.query.mockResolvedValue(mockData);

            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children: h(QueryComponent, { input: { id: 1 } }) })
            );

            expect(getByTestId('status').textContent).toBe('loading');
            expect(getByTestId('isLoading').textContent).toBe('true');
            expect(getByTestId('isFetching').textContent).toBe('true'); // Should be fetching initially

            await waitFor(() => {
                expect(getByTestId('status').textContent).toBe('success');
                expect(getByTestId('isLoading').textContent).toBe('false');
                expect(getByTestId('isFetching').textContent).toBe('false');
                expect(getByTestId('isSuccess').textContent).toBe('true');
                expect(getByTestId('data').textContent).toBe(JSON.stringify(mockData));
                expect(getByTestId('error').textContent).toBe('null');
            });

            expect(mockProcedures.testQuery.query).toHaveBeenCalledTimes(1);
            expect(mockProcedures.testQuery.query).toHaveBeenCalledWith({ id: 1 });
        });

        it('should handle query error state', async () => {
            const mockError = new Error('Query Failed');
            mockProcedures.testQuery.query.mockRejectedValue(mockError);

            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children: h(QueryComponent, { input: { id: 99 } }) })
            );

            expect(getByTestId('status').textContent).toBe('loading');

            await waitFor(() => {
                expect(getByTestId('status').textContent).toBe('error');
                expect(getByTestId('isLoading').textContent).toBe('false'); // Not loading anymore
                expect(getByTestId('isFetching').textContent).toBe('false');
                expect(getByTestId('isSuccess').textContent).toBe('false');
                expect(getByTestId('isError').textContent).toBe('true');
                expect(getByTestId('data').textContent).toBe('undefined'); // No data on error
                expect(getByTestId('error').textContent).toBe('Query Failed');
            });

            expect(mockProcedures.testQuery.query).toHaveBeenCalledTimes(1);
        });

        it('should refetch data when refetch button is clicked', async () => {
            const mockData1 = { id: 1, name: 'First Fetch' };
            const mockData2 = { id: 1, name: 'Second Fetch' };
            mockProcedures.testQuery.query
                .mockResolvedValueOnce(mockData1)
                .mockResolvedValueOnce(mockData2);

            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children: h(QueryComponent, { input: { id: 1 } }) })
            );

            // Wait for initial fetch
            await waitFor(() => expect(getByTestId('status').textContent).toBe('success'));
            expect(getByTestId('data').textContent).toBe(JSON.stringify(mockData1));
            expect(mockProcedures.testQuery.query).toHaveBeenCalledTimes(1);

            // Click refetch
            act(() => {
                getByTestId('refetch').click();
            });

            // Check fetching state during refetch
            expect(getByTestId('isFetching').textContent).toBe('true');
            expect(getByTestId('status').textContent).toBe('success'); // Status remains success during background refetch

            // Wait for refetch to complete
            await waitFor(() => expect(getByTestId('isFetching').textContent).toBe('false'));
            expect(getByTestId('status').textContent).toBe('success');
            expect(getByTestId('data').textContent).toBe(JSON.stringify(mockData2)); // Data updated
            expect(mockProcedures.testQuery.query).toHaveBeenCalledTimes(2); // Called again
        });

        it('should not fetch data when enabled is false', () => {
            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children: h(QueryComponent, { input: { id: 1 }, options: { enabled: false } }) })
            );

            // Should start in success state with no data/error because it's disabled
            expect(getByTestId('status').textContent).toBe('success');
            expect(getByTestId('isLoading').textContent).toBe('false');
            expect(getByTestId('isFetching').textContent).toBe('false');
            expect(getByTestId('isSuccess').textContent).toBe('true');
            expect(getByTestId('data').textContent).toBe('undefined');
            expect(getByTestId('error').textContent).toBe('null');

            // Procedure should not have been called
            expect(mockProcedures.testQuery.query).not.toHaveBeenCalled();
        });

    });

    // --- useMutation Tests ---
    describe('useMutation', () => {
        const MutationComponent = ({ options }: { options?: any }) => {
            // Cast the mocked procedure to the type expected by useMutation
            const procedure = mockClient.testMutation as { mutate: (opts: MutationCallOptions<any, any>) => Promise<any> };
            const { mutate, mutateAsync, data, isLoading, isSuccess, isError, error, status, reset } = useMutation(
                procedure,
                options
            );
            return h('div', null, [
                h('span', { 'data-testid': 'status' }, status),
                h('span', { 'data-testid': 'isLoading' }, String(isLoading)),
                h('span', { 'data-testid': 'isSuccess' }, String(isSuccess)),
                h('span', { 'data-testid': 'isError' }, String(isError)),
                h('span', { 'data-testid': 'data' }, data ? JSON.stringify(data) : 'undefined'),
                h('span', { 'data-testid': 'error' }, error ? error.message : 'null'),
                h('button', { 'data-testid': 'mutate', onClick: () => mutate({ name: 'New Name' }) }, 'Mutate'),
                h('button', { 'data-testid': 'reset', onClick: reset }, 'Reset'),
            ]);
        };

        it('should execute mutation successfully', async () => {
            const mockResult = { success: true, id: 2 };
            // Mock the mutate function on the procedure
            mockProcedures.testMutation.mutate.mockResolvedValue(mockResult);

            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children: h(MutationComponent, null) })
            );

            expect(getByTestId('status').textContent).toBe('idle');

            act(() => {
                getByTestId('mutate').click();
            });

            expect(getByTestId('status').textContent).toBe('loading');
            expect(getByTestId('isLoading').textContent).toBe('true');

            await waitFor(() => {
                expect(getByTestId('status').textContent).toBe('success');
                expect(getByTestId('isLoading').textContent).toBe('false');
                expect(getByTestId('isSuccess').textContent).toBe('true');
                expect(getByTestId('data').textContent).toBe(JSON.stringify(mockResult));
                expect(getByTestId('error').textContent).toBe('null');
            });

            expect(mockProcedures.testMutation.mutate).toHaveBeenCalledTimes(1);
            // Check the arguments passed to the *client proxy's* mutate method
            expect(mockProcedures.testMutation.mutate).toHaveBeenCalledWith(
                expect.objectContaining({ input: { name: 'New Name' } }) // It receives an object with input and potentially optimistic options
            );
        });

        it('should handle mutation error state', async () => {
            const mockError = new Error('Mutation Failed');
            mockProcedures.testMutation.mutate.mockRejectedValue(mockError);

            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children: h(MutationComponent, null) })
            );

            act(() => {
                getByTestId('mutate').click();
            });

            expect(getByTestId('status').textContent).toBe('loading');

            await waitFor(() => {
                expect(getByTestId('status').textContent).toBe('error');
                expect(getByTestId('isLoading').textContent).toBe('false');
                expect(getByTestId('isSuccess').textContent).toBe('false');
                expect(getByTestId('isError').textContent).toBe('true');
                expect(getByTestId('data').textContent).toBe('undefined');
                expect(getByTestId('error').textContent).toBe('Mutation Failed');
            });

            expect(mockProcedures.testMutation.mutate).toHaveBeenCalledTimes(1);
        });

        it('should reset mutation state', async () => {
            const mockResult = { success: true, id: 3 };
            mockProcedures.testMutation.mutate.mockResolvedValue(mockResult);

            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children: h(MutationComponent, null) })
            );

            // Mutate and wait for success
            act(() => { getByTestId('mutate').click(); });
            await waitFor(() => expect(getByTestId('status').textContent).toBe('success'));
            expect(getByTestId('data').textContent).toBe(JSON.stringify(mockResult));

            // Reset
            act(() => {
                getByTestId('reset').click();
            });

            // Check if state is reset
            expect(getByTestId('status').textContent).toBe('idle');
            expect(getByTestId('isLoading').textContent).toBe('false');
            expect(getByTestId('isSuccess').textContent).toBe('false');
            expect(getByTestId('isError').textContent).toBe('false');
            expect(getByTestId('data').textContent).toBe('undefined');
            expect(getByTestId('error').textContent).toBe('null');
        });

        // TODO: Add tests for callbacks (onSuccess, onError, onMutate), optimistic updates
    });

    // --- useSubscription Tests ---
    describe('useSubscription', () => {
        // Mock async iterator setup
        let mockIteratorController: {
            push: (msg: SubscriptionDataMessage | SubscriptionErrorMessage) => void;
            end: () => void;
            error: (err: any) => void;
        };
        let mockUnsubscribe: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            mockUnsubscribe = vi.fn();
            const buffer: (SubscriptionDataMessage | SubscriptionErrorMessage)[] = [];
            let resolveNext: ((value: IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>) => void) | null = null;
            let finished = false;

            const iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage> = {
                [Symbol.asyncIterator]() { return this; },
                async next() {
                    if (buffer.length > 0) {
                        return { done: false, value: buffer.shift()! };
                    }
                    if (finished) {
                        return { done: true, value: undefined };
                    }
                    return new Promise<IteratorResult<SubscriptionDataMessage | SubscriptionErrorMessage>>((resolve) => {
                        resolveNext = resolve;
                    });
                },
                async return() {
                    finished = true;
                    resolveNext?.({ done: true, value: undefined });
                    return { done: true, value: undefined };
                },
                async throw(err) {
                    finished = true;
                    resolveNext?.({ done: true, value: undefined }); // End iteration on throw
                    throw err;
                }
            };

            mockIteratorController = {
                push: (msg) => {
                    if (resolveNext) {
                        resolveNext({ done: false, value: msg });
                        resolveNext = null;
                    } else {
                        buffer.push(msg);
                    }
                },
                end: () => {
                    finished = true;
                    if (resolveNext) {
                        resolveNext({ done: true, value: undefined });
                        resolveNext = null;
                    }
                },
                error: (err) => {
                    finished = true;
                    if (resolveNext) {
                        // This might need adjustment depending on how errors should propagate
                        // For now, just end the iterator
                        resolveNext({ done: true, value: undefined });
                        resolveNext = null;
                    }
                    // Consider throwing the error from the iterator itself if needed
                }
            };

            mockProcedures.testSubscription.subscribe.mockReturnValue({
                iterator,
                unsubscribe: mockUnsubscribe,
            });
        });

        const SubscriptionComponent = ({ input, options }: { input: any, options?: any }) => {
            // Cast the mocked procedure to the type expected by useSubscription
            const procedure = mockClient.testSubscription as { subscribe: (input: any) => { iterator: AsyncIterableIterator<SubscriptionDataMessage | SubscriptionErrorMessage>, unsubscribe: UnsubscribeFn } };
            const { data, status, error, unsubscribe } = useSubscription(
                procedure,
                input,
                options
            );
            return h('div', null, [
                h('span', { 'data-testid': 'status' }, status),
                h('span', { 'data-testid': 'data' }, data ? JSON.stringify(data) : 'null'),
                h('span', { 'data-testid': 'error' }, error ? error.message : 'null'),
                h('button', { 'data-testid': 'unsubscribe', onClick: unsubscribe }, 'Unsubscribe'),
            ]);
        };

        it('should connect and receive data', async () => {
            const onStartMock = vi.fn();
            const onDataMock = vi.fn();
            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children:
                    h(SubscriptionComponent, { input: { topic: 'test' }, options: { onStart: onStartMock, onData: onDataMock } })
                })
            );

            expect(getByTestId('status').textContent).toBe('connecting');

            // Simulate connection start (usually happens internally, but we call onStart callback)
            // In a real scenario, the first data message might trigger 'active'
            await act(async () => {
                 // Wait briefly for effect to run
                 await new Promise(r => setTimeout(r, 0));
            });
            // TODO: Figure out how to reliably test onStart callback trigger
            // expect(onStartMock).toHaveBeenCalled();

            // Simulate receiving data
            const dataMsg: SubscriptionDataMessage = { id: 'sub1', type: 'subscriptionData', data: { value: 'update1' }, serverSeq: 1, prevServerSeq: 0 };
            await act(async () => {
                mockIteratorController.push(dataMsg);
            });

            await waitFor(() => {
                expect(getByTestId('status').textContent).toBe('active');
                expect(getByTestId('data').textContent).toBe(JSON.stringify({ value: 'update1' }));
                expect(getByTestId('error').textContent).toBe('null');
            });
            expect(onDataMock).toHaveBeenCalledWith({ value: 'update1' });

            // Simulate receiving more data
            const dataMsg2: SubscriptionDataMessage = { id: 'sub1', type: 'subscriptionData', data: { value: 'update2' }, serverSeq: 2, prevServerSeq: 1 };
             await act(async () => {
                mockIteratorController.push(dataMsg2);
            });
             await waitFor(() => {
                expect(getByTestId('data').textContent).toBe(JSON.stringify({ value: 'update2' }));
            });
            expect(onDataMock).toHaveBeenCalledWith({ value: 'update2' });
        });

        it('should handle subscription error message', async () => {
            const onErrorMock = vi.fn();
            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children:
                    h(SubscriptionComponent, { input: { topic: 'error-topic' }, options: { onError: onErrorMock } })
                })
            );

            expect(getByTestId('status').textContent).toBe('connecting');

            const errorMsg: SubscriptionErrorMessage = { id: 'sub-err', type: 'subscriptionError', error: { code: 'TEST_ERROR', message: 'Subscription failed!' } };
            await act(async () => {
                mockIteratorController.push(errorMsg);
            });

            await waitFor(() => {
                expect(getByTestId('status').textContent).toBe('error');
                expect(getByTestId('data').textContent).toBe('null');
                expect(getByTestId('error').textContent).toBe('Subscription failed!'); // Error message from payload
            });
            expect(onErrorMock).toHaveBeenCalledWith(errorMsg.error);
        });

        it('should handle subscription end', async () => {
            const onEndMock = vi.fn();
            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children:
                    h(SubscriptionComponent, { input: { topic: 'end-topic' }, options: { onEnd: onEndMock } })
                })
            );

            expect(getByTestId('status').textContent).toBe('connecting');

            // Simulate iterator ending
            await act(async () => {
                mockIteratorController.end();
            });

            await waitFor(() => {
                expect(getByTestId('status').textContent).toBe('ended');
            });
            expect(onEndMock).toHaveBeenCalled();
        });

        it('should call unsubscribe on button click and cleanup', async () => {
            const { getByTestId, unmount } = render(
                h(TypeQLProvider, { client: mockClient, children:
                    h(SubscriptionComponent, { input: { topic: 'unsub-topic' } })
                })
            );

            // Wait for connection (or at least effect to run and set unsubscribe)
            await act(async () => { await new Promise(r => setTimeout(r, 0)); });
            expect(mockProcedures.testSubscription.subscribe).toHaveBeenCalledTimes(1);
            expect(mockUnsubscribe).not.toHaveBeenCalled(); // Not called yet

            // Click unsubscribe button
            act(() => {
                getByTestId('unsubscribe').click();
            });

            // Check if mock unsubscribe was called
            expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
            // Status might go to 'idle' or 'ended' depending on implementation after manual unsub
            // Let's check for 'idle' as it implies cleanup
            await waitFor(() => {
                 expect(getByTestId('status').textContent).toBe('idle');
            });

            // Test cleanup on unmount
            mockUnsubscribe.mockClear();
            unmount();
            expect(mockUnsubscribe).toHaveBeenCalledTimes(1); // Should be called again on unmount cleanup
        });

         it('should not subscribe when enabled is false', () => {
            const { getByTestId } = render(
                h(TypeQLProvider, { client: mockClient, children:
                    h(SubscriptionComponent, { input: { topic: 'disabled-topic' }, options: { enabled: false } })
                })
            );

            expect(getByTestId('status').textContent).toBe('idle');
            expect(getByTestId('data').textContent).toBe('null');
            expect(getByTestId('error').textContent).toBe('null');
            expect(mockProcedures.testSubscription.subscribe).not.toHaveBeenCalled();
        });

    });

}); // End describe block