import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendSingleRequest } from './singleRequest';
import { TypeQLClientError } from '@sylphlab/typeql-shared';
import type { ProcedureCallMessage, ProcedureResultMessage } from '@sylphlab/typeql-shared';

// Mock fetch
const mockFetch = vi.fn();
const mockGetHeaders = vi.fn();

// Replace global fetch with mock before each test
beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockGetHeaders.mockResolvedValue({ 'Content-Type': 'application/json' }); // Default mock
});

// Restore global fetch after each test
afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
});

describe('sendSingleRequest', () => {
    const testUrl = 'http://localhost:3000/typeql';
    const testMessage: ProcedureCallMessage = {
        id: 'req-1',
        type: 'query',
        path: 'getUser',
        input: { id: 1 },
    };
    const mockSuccessResult: ProcedureResultMessage = {
        id: 'req-1',
        result: { type: 'data', data: { id: 1, name: 'Test User' } },
    };

    it('should send a request and return a valid result on success', async () => {
        const mockResponse = new Response(JSON.stringify(mockSuccessResult), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
        mockFetch.mockResolvedValue(mockResponse);

        const result = await sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders);

        expect(mockGetHeaders).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(testUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }, // From mockGetHeaders
            body: JSON.stringify(testMessage),
        });
        expect(result).toEqual(mockSuccessResult);
    });

    it('should throw TypeQLClientError on network failure', async () => {
        const networkError = new Error('Network connection failed');
        mockFetch.mockRejectedValue(networkError);

        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow(TypeQLClientError);
        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow(/Network request failed: Network connection failed/);

        expect(mockGetHeaders).toHaveBeenCalledTimes(2); // Called again on second attempt
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw TypeQLClientError on non-ok HTTP status', async () => {
        const errorBody = 'Internal Server Error';
        const mockResponse = new Response(errorBody, {
            status: 500,
            statusText: 'Server Error',
        });
        mockFetch.mockResolvedValue(mockResponse);

        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow(TypeQLClientError);
        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow(/Request failed: Server Error \(500\) - Internal Server Error/);
        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toHaveProperty('cause', '500');


        expect(mockGetHeaders).toHaveBeenCalledTimes(3);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should throw TypeQLClientError on invalid JSON response', async () => {
        const mockResponse = new Response('this is not json', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
        });
        mockFetch.mockResolvedValue(mockResponse);

        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow(TypeQLClientError);
        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow(/Failed to parse response:/); // Error message might vary slightly

        expect(mockGetHeaders).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

     it('should throw TypeQLClientError on invalid response structure (missing id)', async () => {
        const invalidResult = { result: { data: 'something' } }; // Missing 'id'
        const mockResponse = new Response(JSON.stringify(invalidResult), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
        mockFetch.mockResolvedValue(mockResponse);

        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow(TypeQLClientError);
        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow('Invalid response format received from server.');

        expect(mockGetHeaders).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

     it('should throw TypeQLClientError on invalid response structure (missing result)', async () => {
        const invalidResult = { id: 'req-1', data: 'something' }; // Missing 'result'
        const mockResponse = new Response(JSON.stringify(invalidResult), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
        mockFetch.mockResolvedValue(mockResponse);

        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow(TypeQLClientError);
        await expect(sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders))
            .rejects.toThrow('Invalid response format received from server.');

        expect(mockGetHeaders).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should use provided headers from getHeaders', async () => {
        const mockResponse = new Response(JSON.stringify(mockSuccessResult), { status: 200 });
        mockFetch.mockResolvedValue(mockResponse);
        mockGetHeaders.mockResolvedValue({
            'Authorization': 'Bearer custom-token',
            'X-Test': 'header-val',
        });

        await sendSingleRequest(testMessage, testUrl, mockFetch, mockGetHeaders);

        expect(mockGetHeaders).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(testUrl, expect.objectContaining({
            headers: {
                'Authorization': 'Bearer custom-token',
                'X-Test': 'header-val',
            },
        }));
    });
});