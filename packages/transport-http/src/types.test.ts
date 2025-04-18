import { describe, it, expect } from 'vitest';
import type { HttpTransportOptions, PendingRequest } from './types';
import type { ProcedureCallMessage, ProcedureResultMessage } from '@sylphlab/typeql-shared';

// This file primarily contains type definitions, so tests are minimal.
// We can add basic type checks or interface assignments to ensure they compile.

describe('HttpTransport Types', () => {
    it('HttpTransportOptions should be assignable', () => {
        const options: HttpTransportOptions = {
            url: 'http://example.com',
            fetch: fetch,
            headers: { 'X-Test': 'value' },
            batching: { delayMs: 50 },
        };
        expect(options.url).toBe('http://example.com');
        // Add more checks if specific default behaviors or constraints were defined via types
    });

    it('PendingRequest should be assignable', () => {
         const message: ProcedureCallMessage = { id: '1', type: 'query', path: 'test', input: null };
         const resolve = (value: ProcedureResultMessage) => {};
         const reject = (reason?: any) => {};

        const pending: PendingRequest = {
            message: message,
            resolve: resolve,
            reject: reject,
        };
        expect(pending.message.id).toBe('1');
    });

    // Add more tests here if complex conditional types or mapped types were used.
});