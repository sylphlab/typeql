// packages/preact/src/hooks/useTypeQLClient.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, FunctionalComponent, ComponentChildren } from 'preact';
import { render } from '@testing-library/preact';

// Import hook under test and provider/context
import { useTypeQLClient } from './useTypeQLClient';
import { TypeQLProvider } from '../context'; // Import provider from context file
import { createClient, OptimisticStore } from '@sylphlab/typeql-client';

// Mocks (copied from previous context, might need adjustment if hook interacts more)
const mockTransport = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
};
const mockClient = createClient({ transport: mockTransport as any });
const mockStore = {
    getOptimisticState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {}),
} as unknown as OptimisticStore<any>;

describe('useTypeQLClient (deprecated)', () => {

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('should return the client instance and log a warning', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let capturedClient: any = null;
      const ClientReaderComponent = () => {
          capturedClient = useTypeQLClient(); // Use the deprecated hook
          return h('div', null, 'Client Reader');
      };
      render(
          h(TypeQLProvider, { client: mockClient, store: mockStore, children: h(ClientReaderComponent, null) })
      );
      expect(capturedClient).toBe(mockClient);
      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      expect(consoleWarnSpy).toHaveBeenCalledWith("`useTypeQLClient` is deprecated. Use `useTypeQL().client` instead.");
      consoleWarnSpy.mockRestore();
    });

    // Note: Testing the error case (outside provider) for useTypeQLClient
    // is implicitly covered by the similar test for useTypeQL in context.test.ts,
    // as useTypeQLClient calls useTypeQL internally. If more specific error
    // handling were added to useTypeQLClient itself, a separate test would be needed here.

}); // End of useTypeQLClient describe