{/* packages/react/src/hooks/useTypeQLClient.test.tsx */}
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'; // Add afterAll
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom'; // Ensure matchers are available via setup

// Import hook under test and provider/context
import { useTypeQLClient } from './useTypeQLClient';
import { TypeQLProvider } from '../context'; // Import provider from context file
import { createClient, OptimisticStore } from '@sylphlab/typeql-client';

// Mocks (simple mocks sufficient for this hook)
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
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    beforeEach(() => {
        vi.resetAllMocks();
        consoleWarnSpy.mockClear();
    });

    afterEach(() => {
        cleanup();
    });

    afterAll(() => {
        consoleWarnSpy.mockRestore();
    });

    it('should return the client instance and log a warning', () => {
      let capturedClient: any = null;
      const ClientReaderComponent = () => {
          capturedClient = useTypeQLClient(); // Use the deprecated hook
          return <div>Client Reader</div>;
      };
      render(
          <TypeQLProvider client={mockClient} store={mockStore}>
              <ClientReaderComponent />
          </TypeQLProvider>
      );
      expect(capturedClient).toBe(mockClient);
      expect(consoleWarnSpy).toHaveBeenCalledOnce();
      expect(consoleWarnSpy).toHaveBeenCalledWith("`useTypeQLClient` is deprecated. Use `useTypeQL().client` instead.");
    });

    // Note: Testing the error case (outside provider) for useTypeQLClient
    // is implicitly covered by the similar test for useTypeQL in context.test.tsx,
    // as useTypeQLClient calls useTypeQL internally.

}); // End of useTypeQLClient describe