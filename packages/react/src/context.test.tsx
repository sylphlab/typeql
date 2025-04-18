{/* packages/react/src/context.test.tsx */}
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom'; // For extended matchers (setup file should handle expect extension)

import {
    TypeQLProvider,
    useTypeQL,
    // TypeQLProviderProps, // Not directly used in tests, props inferred
    // TypeQLContextValue // Import if needed
} from './context';
import {
    createClient,
    OptimisticStore,
    createOptimisticStore,
    OptimisticStoreOptions,
    OptimisticStoreError, // Keep type import
    DeltaApplicator, // Import the missing type
} from '@sylphlab/typeql-client';

// --- Mocks ---

// Mock the client creation process
const mockTransport = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
};
const mockClient = createClient({ transport: mockTransport as any });

// Mock OptimisticStore instance (for testing with store prop)
const mockStoreInstance = {
    getOptimisticState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {}),
    // Add other methods if needed for specific tests
} as unknown as OptimisticStore<any>;

// Mock createOptimisticStore for testing internal creation
const mockInternalStoreInstance = {
    getOptimisticState: vi.fn(() => ({ internal: true })),
    subscribe: vi.fn(() => () => {}),
    // Mock cleanup if needed, though usually not asserted directly
    // destroy: vi.fn(),
} as unknown as OptimisticStore<any>;

vi.mock('@sylphlab/typeql-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@sylphlab/typeql-client')>();
    return {
        ...actual,
        createOptimisticStore: vi.fn(() => mockInternalStoreInstance),
    };
});
const createOptimisticStoreMock = vi.mocked(createOptimisticStore);

// Helper component for basic useTypeQL tests
const TestComponent = () => {
  const { client, store } = useTypeQL();
  return (
    <>
      <div data-testid="client-exists">{client ? 'Client Found' : 'Client Not Found'}</div>
      <div data-testid="store-exists">{store ? 'Store Found' : 'Store Not Found'}</div>
      {/* Render store state if needed for specific tests */}
      {store && <div data-testid="store-state">{JSON.stringify(store.getOptimisticState())}</div>}
    </>
  );
};

// --- Tests ---

describe('@sylphlab/typeql-react context', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); // Spy on log for creation messages

    beforeEach(() => {
        vi.resetAllMocks();
        consoleErrorSpy.mockClear();
        consoleLogSpy.mockClear();
        // Reset specific mocks if needed
        vi.mocked(mockStoreInstance.getOptimisticState).mockReturnValue({});
        vi.mocked(mockInternalStoreInstance.getOptimisticState).mockReturnValue({ internal: true });
    });

    afterEach(() => {
        cleanup(); // Ensure cleanup happens after each test
    });

    afterAll(() => {
        consoleErrorSpy.mockRestore();
        consoleLogSpy.mockRestore();
    });

    // --- Provider & Core Hook Tests ---
    describe('TypeQLProvider and useTypeQL', () => {
        it('should throw error if useTypeQL is used outside of TypeQLProvider', () => {
            // Test by expecting render to throw the specific error
            expect(() => render(<TestComponent />)).toThrow(
                '`useTypeQL` must be used within a `TypeQLProvider`.'
            );
            // Check if console.error was called by React's error boundary (it might be)
            // expect(consoleErrorSpy).toHaveBeenCalled();
        });

        it('should provide the client instance via useTypeQL when only client is passed', () => {
            const { getByTestId } = render(
                <TypeQLProvider client={mockClient}>
                    <TestComponent />
                </TypeQLProvider>
            );
            expect(getByTestId('client-exists')).toHaveTextContent('Client Found');
            expect(getByTestId('store-exists')).toHaveTextContent('Store Not Found');
        });

        it('should provide the client and store instances via useTypeQL when both are passed as props', () => {
            const { getByTestId } = render(
                <TypeQLProvider client={mockClient} store={mockStoreInstance}>
                    <TestComponent />
                </TypeQLProvider>
            );
            expect(getByTestId('client-exists')).toHaveTextContent('Client Found');
            expect(getByTestId('store-exists')).toHaveTextContent('Store Found');
            expect(getByTestId('store-state')).toHaveTextContent('{}'); // From mockStoreInstance
        });

        it('should return the correct client and store objects from useTypeQL hook', () => {
            let capturedClient: any = null;
            let capturedStore: any = null;
            const HookReaderComponent = () => {
                const { client, store } = useTypeQL();
                capturedClient = client;
                capturedStore = store;
                return <div>Reader</div>;
            };
            render(
                <TypeQLProvider client={mockClient} store={mockStoreInstance}>
                    <HookReaderComponent />
                </TypeQLProvider>
            );
            expect(capturedClient).toBe(mockClient);
            expect(capturedStore).toBe(mockStoreInstance);
        });

        it('should throw error if both store and storeOptions are provided', () => {
            // Define deltaApplicator implementing the interface
            const deltaApplicator: DeltaApplicator<any, any> = {
                applyDelta: (state: any, delta: any): any => ({ ...state, ...delta })
            };
            const storeOptions: OptimisticStoreOptions<any> = {
                initialState: {}, // Add required initialState
                deltaApplicator: deltaApplicator,
            };
            expect(() => render(
                <TypeQLProvider client={mockClient} store={mockStoreInstance} storeOptions={storeOptions}>
                    <TestComponent />
                </TypeQLProvider>
            )).toThrow("TypeQLProvider cannot accept both 'store' and 'storeOptions' props.");
        });

        describe('Internal Store Creation via storeOptions', () => {
            // Define deltaApplicator implementing the interface
            const deltaApplicator: DeltaApplicator<{ count: number }, Partial<{ count: number }>> = {
                 applyDelta: (state: { count: number }, delta: Partial<{ count: number }>): { count: number } => ({ ...state, ...delta })
            };
            const storeOptions: OptimisticStoreOptions<{ count: number }> = {
                initialState: { count: 0 },
                deltaApplicator: deltaApplicator,
            };

            it('should create store internally when storeOptions are provided', () => {
                render(
                    <TypeQLProvider client={mockClient} storeOptions={storeOptions}>
                        <TestComponent />
                    </TypeQLProvider>
                );
                // Check if createOptimisticStore was called with the correct options structure
                expect(createOptimisticStoreMock).toHaveBeenCalledTimes(1);
                const calledWithOptions = createOptimisticStoreMock.mock.calls[0]?.[0]; // Use optional chaining
                expect(calledWithOptions?.initialState).toEqual({ count: 0 });
                expect(calledWithOptions?.deltaApplicator).toBe(storeOptions.deltaApplicator);
                expect(calledWithOptions).toHaveProperty('onError'); // Provider adds its own onError wrapper
                expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[TypeQLProvider] Creating OptimisticStore internally'));
            });

            it('should provide the internally created store via useTypeQL', () => {
                const { getByTestId } = render(
                    <TypeQLProvider client={mockClient} storeOptions={storeOptions}>
                        <TestComponent />
                    </TypeQLProvider>
                );
                expect(getByTestId('client-exists')).toHaveTextContent('Client Found');
                expect(getByTestId('store-exists')).toHaveTextContent('Store Found');
                // Check if the state comes from the internal mock
                expect(getByTestId('store-state')).toHaveTextContent('{"internal":true}');
                // Verify the hook returns the internally created mock instance
                 let capturedStore: any = null;
                 const HookReaderComponent = () => {
                     const { store } = useTypeQL();
                     capturedStore = store;
                     return null;
                 };
                 render(
                     <TypeQLProvider client={mockClient} storeOptions={storeOptions}>
                         <HookReaderComponent />
                     </TypeQLProvider>
                 );
                 expect(capturedStore).toBe(mockInternalStoreInstance);
            });

            it('should call onStoreError and original storeOptions.onError when internal store errors', () => {
                const userOnError = vi.fn();
                const optionsOnError = vi.fn();
                // Create a mock error object matching the OptimisticStoreError interface
                const testError: OptimisticStoreError = {
                    type: 'RejectionError', // Use a valid type from the interface
                    message: 'Test internal error',
                    // cause: undefined // 'cause' is not part of the interface, use originalError
                    originalError: new Error('Original Cause') // Optional: provide original error
                };

                const optionsWithHandler: OptimisticStoreOptions<any> = {
                    ...storeOptions,
                    onError: optionsOnError,
                };

                render(
                    <TypeQLProvider client={mockClient} storeOptions={optionsWithHandler} onStoreError={userOnError}>
                        <TestComponent />
                    </TypeQLProvider>
                );

                // Simulate an error by calling the onError passed to createOptimisticStore
                const internalOnError = createOptimisticStoreMock.mock.calls[0]?.[0]?.onError; // Use optional chaining
                expect(internalOnError).toBeDefined();
                act(() => {
                    internalOnError!(testError); // Use non-null assertion as we expect it to be defined
                });

                // Verify console.error was called by the provider's wrapper
                expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[TypeQLProvider Internal Store Error]'), testError);
                // Verify the user's onStoreError prop was called
                expect(userOnError).toHaveBeenCalledTimes(1);
                expect(userOnError).toHaveBeenCalledWith(testError);
                // Verify the original onError from storeOptions was also called
                expect(optionsOnError).toHaveBeenCalledTimes(1);
                expect(optionsOnError).toHaveBeenCalledWith(testError);
            });

            it('should perform cleanup for internally created store on unmount', () => {
                 const { unmount } = render(
                    <TypeQLProvider client={mockClient} storeOptions={storeOptions}>
                        <TestComponent />
                    </TypeQLProvider>
                );
                expect(createOptimisticStoreMock).toHaveBeenCalledTimes(1);
                expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[TypeQLProvider] Creating OptimisticStore internally'));

                act(() => {
                    unmount();
                });

                // Verify cleanup log message
                expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[TypeQLProvider] Cleaning up internally created OptimisticStore'));
                // If the mock store had a destroy method, we could assert it was called:
                // expect(mockInternalStoreInstance.destroy).toHaveBeenCalledTimes(1);
                // We can also check if the internal ref is likely cleared, though direct access isn't feasible.
                // Re-rendering after unmount isn't standard, but confirms no lingering state issues.
            });
        });
    }); // End of TypeQLProvider and useTypeQL describe
}); // End of top-level describe