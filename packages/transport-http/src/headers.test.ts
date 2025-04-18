import { describe, it, expect, vi } from 'vitest';
import { createHeaderGetter } from './headers';
import type { HttpTransportOptions } from './types';

describe('createHeaderGetter', () => {
    it('should return default content-type header when no options are provided', async () => {
        const options: Pick<HttpTransportOptions, 'headers'> = {};
        const getHeaders = createHeaderGetter(options);
        const headers = await getHeaders();
        const headersObj = new Headers(headers);
        expect(headersObj.get('Content-Type')).toBe('application/json');
        expect(Array.from(headersObj.keys()).length).toBe(1);
    });

    it('should merge static headers from options', async () => {
        const options: Pick<HttpTransportOptions, 'headers'> = {
            headers: {
                'Authorization': 'Bearer test-token',
                'X-Custom': 'value1',
            },
        };
        const getHeaders = createHeaderGetter(options);
        const headers = await getHeaders();
        const headersObj = new Headers(headers);
        expect(headersObj.get('Content-Type')).toBe('application/json');
        expect(headersObj.get('Authorization')).toBe('Bearer test-token');
        expect(headersObj.get('X-Custom')).toBe('value1');
        expect(Array.from(headersObj.keys()).length).toBe(3);
    });

    it('should call header function and merge dynamic headers', async () => {
        const dynamicHeaderFn = vi.fn().mockResolvedValue({
            'Authorization': 'Bearer dynamic-token',
            'X-Dynamic': 'value2',
        });
        const options: Pick<HttpTransportOptions, 'headers'> = {
            headers: dynamicHeaderFn,
        };
        const getHeaders = createHeaderGetter(options);
        const headers = await getHeaders();
        const headersObj = new Headers(headers);

        expect(dynamicHeaderFn).toHaveBeenCalledTimes(1);
        expect(headersObj.get('Content-Type')).toBe('application/json');
        expect(headersObj.get('Authorization')).toBe('Bearer dynamic-token');
        expect(headersObj.get('X-Dynamic')).toBe('value2');
        expect(Array.from(headersObj.keys()).length).toBe(3);
    });

    it('should override default headers with provided headers', async () => {
        const options: Pick<HttpTransportOptions, 'headers'> = {
            headers: {
                'Content-Type': 'application/vnd.api+json', // Override
            },
        };
        const getHeaders = createHeaderGetter(options);
        const headers = await getHeaders();
        const headersObj = new Headers(headers);
        expect(headersObj.get('Content-Type')).toBe('application/vnd.api+json');
        expect(Array.from(headersObj.keys()).length).toBe(1);
    });

     it('should handle async header function', async () => {
        const asyncHeaderFn = vi.fn().mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 10)); // Simulate async work
            return { 'Authorization': 'Bearer async-token' };
        });
        const options: Pick<HttpTransportOptions, 'headers'> = {
            headers: asyncHeaderFn,
        };
        const getHeaders = createHeaderGetter(options);
        const headers = await getHeaders();
        const headersObj = new Headers(headers);

        expect(asyncHeaderFn).toHaveBeenCalledTimes(1);
        expect(headersObj.get('Content-Type')).toBe('application/json');
        expect(headersObj.get('Authorization')).toBe('Bearer async-token');
    });
});