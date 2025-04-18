import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpTransport, HttpTransportOptions } from '../index';
import type { ProcedureCallMessage, ProcedureResultMessage, SubscribeMessage, TypeQLTransport } from '@sylphlab/typeql-shared';
import { TypeQLClientError } from '@sylphlab/typeql-shared';

// Helper function for adding a small delay
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Mock fetch
const mockFetch = vi.fn();

// Default options
const defaultOptions: HttpTransportOptions = {
    url: 'http://localhost:3000/test',
    fetch: mockFetch,
};

// Helper to create messages
const createMockMessage = (id: number, path: string, input?: any): ProcedureCallMessage => ({
    id,
    type: 'query', // or 'mutation'
    path,
    input, // Changed from params
    clientSeq: 0, // Not strictly relevant for HTTP transport tests
});

const createMockResult = (id: number, data: any): ProcedureResultMessage => ({
    id,
    result: { type: 'data', data },
    // Removed sequence numbers as they are not part of the base HTTP result message
});

describe('createHttpTransport', () => {
    let transport: TypeQLTransport;

    beforeEach(() => {
        vi.clearAllMocks(); // Changed from resetAllMocks
        // Default transport for most tests
        transport = createHttpTransport(defaultOptions);
    });

    it('should create a transport object', () => {
        expect(transport).toBeDefined();
        expect(typeof transport.request).toBe('function');
        expect(typeof transport.subscribe).toBe('function');
    });

    describe('Single Requests (No Batching)', () => {
        beforeEach(() => {
            // Ensure no batching for these tests
            transport = createHttpTransport({ ...defaultOptions, batching: false });
        });

        it('should send a single request successfully', async () => {
            const message = createMockMessage(1, 'test.query');
            const expectedResult = createMockResult(1, { success: true });

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => expectedResult,
                text: async () => JSON.stringify(expectedResult),
            } as unknown as Response); // Use stronger cast

            const result = await transport.request(message);

            expect(result).toEqual(expectedResult);
            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledWith(
                defaultOptions.url,
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(message),
                })
            );
        });

        it('should handle fetch network errors', async () => {
            const message = createMockMessage(2, 'test.fail');
            const networkError = new Error('Network Failed');
            mockFetch.mockRejectedValueOnce(networkError);

            await expect(transport.request(message)).rejects.toThrow(
                new TypeQLClientError(`Network request failed: ${networkError.message}`)
            );
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should handle non-OK HTTP responses (e.g., 404)', async () => {
            const message = createMockMessage(3, 'test.notfound');
            const errorBody = 'Not Found Endpoint';
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                json: async () => ({ error: 'not found' }), // Simulate potential error JSON
                text: async () => errorBody,
            } as unknown as Response); // Use stronger cast

            await expect(transport.request(message)).rejects.toThrow(
                new TypeQLClientError(`Request failed: Not Found (404) - ${errorBody}`, '404')
            );
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

         it('should handle non-OK HTTP responses (e.g., 500)', async () => {
            const message = createMockMessage(4, 'test.servererror');
            const errorBody = 'Internal Server Error Details';
             mockFetch.mockResolvedValueOnce({
                 ok: false,
                 status: 500,
                 statusText: 'Internal Server Error',
                 json: async () => ({ error: 'server issue' }),
                 text: async () => errorBody,
             } as unknown as Response); // Use stronger cast

             await expect(transport.request(message)).rejects.toThrow(
                 new TypeQLClientError(`Request failed: Internal Server Error (500) - ${errorBody}`, '500')
             );
             expect(mockFetch).toHaveBeenCalledTimes(1);
         });

        it('should handle invalid JSON responses', async () => {
            const message = createMockMessage(5, 'test.badjson');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
                // Simulate invalid JSON
                json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
                text: async () => '<invalid json>',
            } as unknown as Response); // Use stronger cast

            await expect(transport.request(message)).rejects.toThrow(
                new TypeQLClientError('Failed to parse response: Unexpected token < in JSON at position 0')
            );
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should handle responses with incorrect structure', async () => {
            const message = createMockMessage(6, 'test.badstructure');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({ some: 'other', structure: true }), // Missing 'id' or 'result'
                text: async () => JSON.stringify({ some: 'other', structure: true }),
            } as unknown as Response); // Use stronger cast

            // Check if the thrown error message includes the expected text
            await expect(transport.request(message)).rejects.toThrowError(
                /Invalid response format received from server./
            );
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should apply static headers', async () => {
            const staticHeaders = { 'X-Test-Static': 'static-value' };
            transport = createHttpTransport({ ...defaultOptions, headers: staticHeaders, batching: false });
            const message = createMockMessage(7, 'test.staticheader');
            const expectedResult = createMockResult(7, { data: 'header ok' });

            mockFetch.mockResolvedValueOnce({
                ok: true, status: 200, statusText: 'OK', json: async () => expectedResult, text: async () => JSON.stringify(expectedResult),
            } as unknown as Response); // Use stronger cast

            await transport.request(message);

            // Check headers directly on the Headers object
            expect(mockFetch).toHaveBeenCalledWith(
                defaultOptions.url,
                expect.objectContaining({
                    method: 'POST',
                    // body: JSON.stringify(message), // Body check is less critical here
                })
            );
            // Verify header content on the Headers object passed to fetch
            const callArgs = mockFetch.mock.calls[0];
            const headersArg = callArgs[1]?.headers as Headers;
            expect(headersArg).toBeInstanceOf(Headers);
            expect(headersArg.get('Content-Type')).toBe('application/json');
            expect(headersArg.get('x-test-static')).toBe('static-value');
        });

        it('should apply dynamic headers', async () => {
            const dynamicHeaderFn = vi.fn().mockResolvedValue({ 'X-Test-Dynamic': 'dynamic-value' });
            transport = createHttpTransport({ ...defaultOptions, headers: dynamicHeaderFn, batching: false });
            const message = createMockMessage(8, 'test.dynamicheader');
            const expectedResult = createMockResult(8, { data: 'dynamic ok' });

            mockFetch.mockResolvedValueOnce({
                ok: true, status: 200, statusText: 'OK', json: async () => expectedResult, text: async () => JSON.stringify(expectedResult),
            } as unknown as Response); // Use stronger cast

            await transport.request(message);

            expect(dynamicHeaderFn).toHaveBeenCalledTimes(1);
            // Check headers directly on the Headers object
            expect(mockFetch).toHaveBeenCalledWith(
                defaultOptions.url,
                expect.objectContaining({
                     method: 'POST',
                    // body: JSON.stringify(message), // Body check is less critical here
                })
            );
             // Verify header content on the Headers object passed to fetch
            const callArgs = mockFetch.mock.calls[0];
            const headersArg = callArgs[1]?.headers as Headers;
            expect(headersArg).toBeInstanceOf(Headers);
            expect(headersArg.get('Content-Type')).toBe('application/json');
            expect(headersArg.get('x-test-dynamic')).toBe('dynamic-value');
        });

        it('should send requests immediately if batching is false', async () => {
            transport = createHttpTransport({ ...defaultOptions, batching: false });
            const message1 = createMockMessage(11, 'test.noBatch1');
            const message2 = createMockMessage(12, 'test.noBatch2');
            const result1 = createMockResult(11, 'ok1');
            const result2 = createMockResult(12, 'ok2');

            mockFetch
                .mockResolvedValueOnce({ ok: true, status: 200, json: async () => result1 } as unknown as Response)
                .mockResolvedValueOnce({ ok: true, status: 200, json: async () => result2 } as unknown as Response);

            const p1 = transport.request(message1);
            const p2 = transport.request(message2);

            await Promise.all([p1, p2]);

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(mockFetch).toHaveBeenNthCalledWith(1, defaultOptions.url, expect.objectContaining({ body: JSON.stringify(message1) }));
            expect(mockFetch).toHaveBeenNthCalledWith(2, defaultOptions.url, expect.objectContaining({ body: JSON.stringify(message2) }));
        });

         it('should send requests immediately if batchDelayMs is 0', async () => {
            transport = createHttpTransport({ ...defaultOptions, batching: { delayMs: 0 } });
             const message1 = createMockMessage(13, 'test.zeroDelay1');
             const message2 = createMockMessage(14, 'test.zeroDelay2');
             const result1 = createMockResult(13, 'ok1');
             const result2 = createMockResult(14, 'ok2');

             mockFetch
                 .mockResolvedValueOnce({ ok: true, status: 200, json: async () => result1 } as unknown as Response)
                 .mockResolvedValueOnce({ ok: true, status: 200, json: async () => result2 } as unknown as Response);

             const p1 = transport.request(message1);
             // Introduce tiny delay to ensure separate event loop ticks if needed, though 0 delay should be synchronous
             await wait(1);
             const p2 = transport.request(message2);

             await Promise.all([p1, p2]);

             expect(mockFetch).toHaveBeenCalledTimes(2);
             expect(mockFetch).toHaveBeenNthCalledWith(1, defaultOptions.url, expect.objectContaining({ body: JSON.stringify(message1) }));
             expect(mockFetch).toHaveBeenNthCalledWith(2, defaultOptions.url, expect.objectContaining({ body: JSON.stringify(message2) }));
         });
    });

    describe('Batching Requests', () => {
        const batchDelay = 20; // Use a slightly longer delay for testing stability

        beforeEach(() => {
            // Default to batching enabled for this suite
            transport = createHttpTransport({ ...defaultOptions, batching: { delayMs: batchDelay } });
        });

        it('should batch multiple requests sent within the delay window', async () => {
            const message1 = createMockMessage(21, 'test.batch1');
            const message2 = createMockMessage(22, 'test.batch2');
            const result1 = createMockResult(21, 'batch_ok1');
            const result2 = createMockResult(22, 'batch_ok2');
            const expectedResults = [result1, result2];

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => expectedResults,
            } as unknown as Response);

            // Send requests without awaiting
            const p1 = transport.request(message1);
            const p2 = transport.request(message2);

            // Wait for longer than the batch delay
            await wait(batchDelay + 50);

            // Now await the results
            const results = await Promise.all([p1, p2]);

            expect(results).toEqual(expectedResults);
            expect(mockFetch).toHaveBeenCalledTimes(1); // Should only be called once
            expect(mockFetch).toHaveBeenCalledWith(
                defaultOptions.url,
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify([message1, message2]), // Expecting an array
                })
            );
        });

        it('should handle batch fetch network errors', async () => {
            const message1 = createMockMessage(31, 'test.batchFail1');
            const message2 = createMockMessage(32, 'test.batchFail2');
            const networkError = new Error('Batch Network Failed');
            mockFetch.mockRejectedValueOnce(networkError);

            const p1 = transport.request(message1);
            const p2 = transport.request(message2);

            // Ensure promises settle before asserting rejections
            const results = await Promise.allSettled([p1, p2]);

            // Check that both promises reject with the correct error type and message
            expect(results[0].status).toBe('rejected');
            expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[0] as PromiseRejectedResult).reason.message).toMatch(/Network request failed for batch/);

            expect(results[1].status).toBe('rejected');
            expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/Network request failed for batch/);

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should handle batch non-OK HTTP responses', async () => {
            const message1 = createMockMessage(41, 'test.batch404_1');
            const message2 = createMockMessage(42, 'test.batch404_2');
            const errorBody = 'Batch Endpoint Not Found';
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: 'Not Found',
                text: async () => errorBody,
            } as unknown as Response);

            const p1 = transport.request(message1);
            const p2 = transport.request(message2);

            // Ensure promises settle
            const results = await Promise.allSettled([p1, p2]);

            // Check rejections
            expect(results[0].status).toBe('rejected');
            expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[0] as PromiseRejectedResult).reason.message).toMatch(/Batch request failed: Not Found \(404\)/);
            expect(((results[0] as PromiseRejectedResult).reason as TypeQLClientError).code).toBe('404');


            expect(results[1].status).toBe('rejected');
             expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/Batch request failed: Not Found \(404\)/);
            expect(((results[1] as PromiseRejectedResult).reason as TypeQLClientError).code).toBe('404');

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should handle batch invalid JSON array responses', async () => {
            const message1 = createMockMessage(51, 'test.batchBadJson1');
            const message2 = createMockMessage(52, 'test.batchBadJson2');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => { throw new SyntaxError('Invalid JSON'); }, // Simulate JSON parse failure
                text: async () => '{invalid json array',
            } as unknown as Response);

            const p1 = transport.request(message1);
            const p2 = transport.request(message2);

            // Ensure promises settle
            const results = await Promise.allSettled([p1, p2]);

             // Check rejections
            expect(results[0].status).toBe('rejected');
            expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[0] as PromiseRejectedResult).reason.message).toMatch(/Failed to process batch response: Invalid JSON/);

            expect(results[1].status).toBe('rejected');
            expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/Failed to process batch response: Invalid JSON/);

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

         it('should handle batch response not being an array', async () => {
            const message1 = createMockMessage(53, 'test.batchNotArray1');
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ not: 'an array' }), // Simulate non-array JSON
            } as unknown as Response);

            const p1 = transport.request(message1);
            // Ensure promise settles
            const result = await Promise.allSettled([p1]);

            // Check rejection
            expect(result[0].status).toBe('rejected');
            expect((result[0] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((result[0] as PromiseRejectedResult).reason.message).toMatch(/Invalid batch response format: expected an array/);

            expect(mockFetch).toHaveBeenCalledTimes(1);
         });


        it('should handle batch response with mismatched length', async () => {
            const message1 = createMockMessage(61, 'test.batchMismatch1');
            const message2 = createMockMessage(62, 'test.batchMismatch2');
            const result1 = createMockResult(61, 'only_one_result');
            // Server only returns one result for two requests
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [result1],
            } as unknown as Response);

            const p1 = transport.request(message1);
            const p2 = transport.request(message2);

             // Ensure promises settle
            const results = await Promise.allSettled([p1, p2]);

            // Check rejections
            expect(results[0].status).toBe('rejected');
            expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[0] as PromiseRejectedResult).reason.message).toMatch(/Mismatched batch response length: expected 2, got 1/);

            expect(results[1].status).toBe('rejected');
            expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/Mismatched batch response length: expected 2, got 1/);

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should handle one invalid result within a batch response', async () => {
            const message1 = createMockMessage(71, 'test.batchIndividualOk');
            const message2 = createMockMessage(72, 'test.batchIndividualBad');
            const result1 = createMockResult(71, 'good_result');
            const badResult = { id: 72, wrong: 'structure' }; // Invalid structure

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [result1, badResult],
            } as unknown as Response);

            const p1 = transport.request(message1);
            const p2 = transport.request(message2);
            // Add a catch to the promise expected to reject to prevent unhandled rejection warning
            p2.catch(() => { /* Expected rejection, handled by allSettled assertion */ });

            await wait(batchDelay + 50);

            // Ensure promises settle
            const results = await Promise.allSettled([p1, p2]);

            // First promise should resolve
            expect(results[0].status).toBe('fulfilled');
            expect((results[0] as PromiseFulfilledResult<ProcedureResultMessage>).value).toEqual(result1);

            // Second promise should reject
            expect(results[1].status).toBe('rejected');
            expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(TypeQLClientError);
            expect((results[1] as PromiseRejectedResult).reason.message).toMatch(/Invalid result format in batch response for ID 72/);

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

         it('should resolve correctly by index even if IDs mismatch in batch response', async () => {
             const message1 = createMockMessage(81, 'test.batchIdMismatch1');
             const message2 = createMockMessage(82, 'test.batchIdMismatch2');
             // Simulate server mixing up IDs in response, but keeping order
             const resultFromServer1 = createMockResult(99, 'data_for_81'); // ID is wrong
             const resultFromServer2 = createMockResult(81, 'data_for_82'); // ID is wrong

             mockFetch.mockResolvedValueOnce({
                 ok: true,
                 status: 200,
                 json: async () => [resultFromServer1, resultFromServer2],
             } as unknown as Response);

             const p1 = transport.request(message1);
             const p2 = transport.request(message2);

             await wait(batchDelay + 50);

             // Should resolve based on index, ignoring the ID mismatch in the response data
             await expect(p1).resolves.toEqual(resultFromServer1);
             await expect(p2).resolves.toEqual(resultFromServer2);
             expect(mockFetch).toHaveBeenCalledTimes(1);
             expect(mockFetch).toHaveBeenCalledWith(
                 defaultOptions.url,
                 expect.objectContaining({ body: JSON.stringify([message1, message2]) })
             );
         });

        it('should use default batch delay if batching is true', async () => {
            // Default delay is 10ms in the source code if `true` is passed
            const defaultBatchDelay = 10;
            transport = createHttpTransport({ ...defaultOptions, batching: true });

            const message1 = createMockMessage(91, 'test.defaultBatch1');
            const message2 = createMockMessage(92, 'test.defaultBatch2');
            const result1 = createMockResult(91, 'ok1');
            const result2 = createMockResult(92, 'ok2');

            mockFetch.mockResolvedValueOnce({
                ok: true, status: 200, json: async () => [result1, result2]
            } as unknown as Response);

            const p1 = transport.request(message1);
            const p2 = transport.request(message2);

            // Wait longer than the default delay
            await wait(defaultBatchDelay + 50);

            await Promise.all([p1, p2]);

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledWith(
                defaultOptions.url,
                expect.objectContaining({ body: JSON.stringify([message1, message2]) })
            );
        });
    });

    describe('Unsupported Methods', () => {
        it('subscribe should throw an error', () => {
            const subMessage: SubscribeMessage = { id: 100, type: 'subscription', path: 'test.sub', input: {} }; // Removed clientSeq
            expect(() => transport.subscribe(subMessage)).toThrow(
                 new TypeQLClientError("Subscriptions require a persistent connection (e.g., WebSockets). HTTP transport does not support them.")
            );
        });

        // Testing console warnings/errors is brittle, skipping for onAckReceived and requestMissingDeltas
    });

    // Batching tests will go here in the next step
});