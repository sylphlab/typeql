// packages/react/src/client.test.ts
import { describe, it, expect } from 'vitest';
// Import symbols from './client' to test
import { createClient, createOptimisticStore } from './client';
// Import types if needed for tests
// import type { TypeQLClientError, OptimisticStoreError } from './client';

describe('client re-exports', () => {
    it('should re-export createClient function', () => {
        expect(createClient).toBeDefined();
        // Add basic check if possible, e.g., typeof
        expect(typeof createClient).toBe('function');
    });

    it('should re-export createOptimisticStore function', () => {
        expect(createOptimisticStore).toBeDefined();
        expect(typeof createOptimisticStore).toBe('function');
    });

    // Add more tests for other exported types/functions if necessary
    // e.g., checking if types are accessible or if specific errors can be instantiated

    it('placeholder test for other exports', () => {
        // This test is a placeholder.
        // TODO: Add tests for specific types or error classes if needed.
        expect(true).toBe(true);
    });
});