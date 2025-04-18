// packages/preact/src/context.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, Fragment, FunctionalComponent, ComponentChildren } from 'preact';
import { render } from '@testing-library/preact';

// Import from the new context file
import {
    TypeQLProvider,
    useTypeQL,
    TypeQLProviderProps,
    TypeQLContextValue // Import if needed, or rely on inference
} from './context';
import { createClient, OptimisticStore } from '@sylphlab/typeql-client';

// Mock the client creation process (Keep mocks needed for these tests)
const mockTransport = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
};
const mockClient = createClient({ transport: mockTransport as any });
const mockStore = { // Simplified mock for context tests
    getOptimisticState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {}),
    // Add other methods if TypeQLProvider interacts with them directly (unlikely)
} as unknown as OptimisticStore<any>; // Cast for simplicity in this context

// Helper component for basic useTypeQL tests
const TestComponent = () => {
  const { client, store } = useTypeQL();
  return h(Fragment, null, [
    h('div', { 'data-testid': 'client-exists' }, client ? 'Client Found' : 'Client Not Found'),
    h('div', { 'data-testid': 'store-exists' }, store ? 'Store Found' : 'Store Not Found'),
  ]);
};

describe('@sylphlab/typeql-preact context', () => { // Updated describe name

  beforeEach(() => {
      vi.resetAllMocks();
      // Reset specific mocks if needed for context tests
      // getOptimisticStateMock.mockReturnValue({});
  });

  // --- Provider & Core Hook Tests ---
  describe('TypeQLProvider and useTypeQL', () => {
    it('should throw error if useTypeQL is used outside of TypeQLProvider', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Test by expecting render to throw the specific error
      // The hook itself throws the specific error, which render catches
      expect(() => render(h(TestComponent, null))).toThrow(
        '`useTypeQL` must be used within a `TypeQLProvider`.'
      );
      consoleErrorSpy.mockRestore();
    });

    it('should provide the client instance via useTypeQL', () => {
      const wrapper: FunctionalComponent = ({ children }: { children?: ComponentChildren }) =>
        h(TypeQLProvider, { client: mockClient, children });
      const { getByTestId } = render(h(TestComponent, null), { wrapper });
      expect(getByTestId('client-exists').textContent).toBe('Client Found');
      expect(getByTestId('store-exists').textContent).toBe('Store Not Found');
    });

    it('should provide the client and store instances via useTypeQL', () => {
        const wrapper: FunctionalComponent = ({ children }: { children?: ComponentChildren }) =>
          h(TypeQLProvider, { client: mockClient, store: mockStore, children });
        const { getByTestId } = render(h(TestComponent, null), { wrapper });
        expect(getByTestId('client-exists').textContent).toBe('Client Found');
        expect(getByTestId('store-exists').textContent).toBe('Store Found');
    });

     it('should return the correct client and store objects from useTypeQL hook', () => {
        let capturedClient: any = null;
        let capturedStore: any = null;
        const HookReaderComponent = () => {
            const { client, store } = useTypeQL();
            capturedClient = client;
            capturedStore = store;
            return h('div', null, 'Reader');
        };
        render(
            h(TypeQLProvider, { client: mockClient, store: mockStore, children: h(HookReaderComponent, null) })
        );
        expect(capturedClient).toBe(mockClient);
        expect(capturedStore).toBe(mockStore);
     });
  }); // End of TypeQLProvider and useTypeQL describe

}); // End of top-level describe