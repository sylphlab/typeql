import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpTransport, HttpError, type BatchResponsePayload } from './index'; // Adjust path if needed
import type {
  ProcedureCallMessage,
  ProcedureResultMessage,
  SubscribeMessage,
} from '@sylphlab/typeql-shared';

// Mock the global fetch API
const mockFetch = vi.fn();
const originalFetch = global.fetch;

describe('createHttpTransport', () => {
  const testUrl = 'http://localhost:3000/typeql';

  beforeEach(() => {
    // Assign the mock before each test
    global.fetch = mockFetch;
    // Reset mock state before each test
    mockFetch.mockClear();
  });

  afterEach(() => {
    // Restore the original fetch after each test
    global.fetch = originalFetch;
  });

  it('should create a transport object with request and subscribe methods', () => {
    const transport = createHttpTransport({ url: testUrl });
    expect(transport).toBeDefined();
    expect(typeof transport.request).toBe('function');
    expect(typeof transport.subscribe).toBe('function');
  });

  describe('request method', () => {
    it('should make a POST request to the specified URL with correct headers and body for a single request', async () => {
      const transport = createHttpTransport({ url: testUrl });
      const requestPayload: ProcedureCallMessage = {
        id: 1,
        type: 'query',
        path: 'test.get',
        input: { id: 'abc' },
      };
      const mockResponseData: ProcedureResultMessage = {
        id: 1,
        result: { type: 'data', data: { success: true, id: 'abc' } },
      };

      // Mock successful fetch response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockResponseData,
        text: async () => JSON.stringify(mockResponseData), // Add text() for error cases
      });

      await transport.request(requestPayload);

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledWith(testUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(requestPayload),
      });
    });

    it('should return the parsed JSON response on success for a single request', async () => {
       const transport = createHttpTransport({ url: testUrl });
       const requestPayload: ProcedureCallMessage = { id: 2, type: 'query', path: 'test.get' };
       const mockResponseData: ProcedureResultMessage = {
         id: 2,
         result: { type: 'data', data: { message: 'hello' } },
       };

       mockFetch.mockResolvedValueOnce({
         ok: true,
         status: 200,
         json: async () => mockResponseData,
         text: async () => JSON.stringify(mockResponseData),
       });

       const result = await transport.request(requestPayload);
       expect(result).toEqual(mockResponseData);
    });

    // TODO: Add test for batch request (requires server expectation knowledge or flexible mock)
    // it('should handle batch requests correctly', async () => { ... });

    it('should throw HttpError on non-ok response (e.g., 404, 500)', async () => {
      const transport = createHttpTransport({ url: testUrl });
      const requestPayload: ProcedureCallMessage = { id: 3, type: 'mutation', path: 'test.update' };
      const errorBody = { error: 'Not Found' };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => errorBody,
        text: async () => JSON.stringify(errorBody),
      });

      try {
        await transport.request(requestPayload);
        // If it doesn't throw, fail the test
        expect.fail('Expected request to throw HttpError, but it did not.');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        // Type assertion for detailed checks
        const httpError = error as HttpError;
        expect(httpError.name).toBe('HttpError');
        expect(httpError.status).toBe(404);
        expect(httpError.statusText).toBe('Not Found');
        expect(httpError.body).toEqual(errorBody);
        expect(httpError.message).toBe('HTTP Error 404 (Not Found)');
      }
    });

     it('should throw HttpError on non-ok response when body is not JSON', async () => {
       const transport = createHttpTransport({ url: testUrl });
       const requestPayload: ProcedureCallMessage = { id: 4, type: 'query', path: 'test.fail' };
       const errorText = 'Internal Server Error';

       mockFetch.mockResolvedValueOnce({
         ok: false,
         status: 500,
         statusText: 'Internal Server Error',
         json: async () => { throw new Error('Not JSON'); },
         text: async () => errorText,
       });

       try {
         await transport.request(requestPayload);
         expect.fail('Expected request to throw HttpError, but it did not.');
       } catch (error) {
         expect(error).toBeInstanceOf(HttpError);
         const httpError = error as HttpError;
         expect(httpError.name).toBe('HttpError');
         expect(httpError.status).toBe(500);
         expect(httpError.statusText).toBe('Internal Server Error');
         expect(httpError.body).toBe(errorText);
         expect(httpError.message).toBe('HTTP Error 500 (Internal Server Error)');
       }
     });

    it('should wrap network errors (fetch throws)', async () => {
      const transport = createHttpTransport({ url: testUrl });
      const requestPayload: ProcedureCallMessage = { id: 5, type: 'query', path: 'test.network' };
      const networkError = new Error('Network connection failed');

      mockFetch.mockRejectedValueOnce(networkError);

      await expect(transport.request(requestPayload)).rejects.toThrow(
        `TypeQL HTTP Request Failed: ${networkError.message}`
      );
       // Check it's not an HttpError instance
       try {
         await transport.request(requestPayload);
       } catch (e) {
         expect(e).toBeInstanceOf(Error);
         expect(e).not.toBeInstanceOf(HttpError);
       }
    });

    it('should pass through fetchOptions', async () => {
        const customHeaders = { Authorization: 'Bearer token' };
        const transport = createHttpTransport({
            url: testUrl,
            fetchOptions: { headers: customHeaders, cache: 'no-cache' }
        });
        const requestPayload: ProcedureCallMessage = { id: 6, type: 'query', path: 'test.auth' };
        const mockResponseData: ProcedureResultMessage = { id: 6, result: { type: 'data', data: {} } };

        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockResponseData,
            text: async () => JSON.stringify(mockResponseData),
        });

        await transport.request(requestPayload);

        expect(mockFetch).toHaveBeenCalledOnce();
        expect(mockFetch).toHaveBeenCalledWith(testUrl, {
            method: 'POST',
            headers: {
                ...customHeaders, // User headers should be present
                'Content-Type': 'application/json', // Standard headers should still be there
                Accept: 'application/json',
            },
            body: JSON.stringify(requestPayload),
            cache: 'no-cache', // Other options should be passed
        });
    });

    // TODO: Add test for batch request (requires server expectation knowledge or flexible mock)
    // it('should handle batch requests correctly', async () => { ... });

  }); // End of 'request method' describe

  // --- Batching Tests ---
  describe('request method with batching enabled', () => {
    beforeEach(() => {
      vi.useFakeTimers(); // Use fake timers for batching tests
    });

    afterEach(() => {
      vi.restoreAllMocks(); // Restore mocks
      vi.useRealTimers(); // Restore real timers after each test
    });

    it('should batch multiple requests into a single fetch call after delay', async () => {
      const delayMs = 50;
      const transport = createHttpTransport({ url: testUrl, batching: { delayMs } });
      const request1: ProcedureCallMessage = { id: 10, type: 'query', path: 'batch.1' };
      const request2: ProcedureCallMessage = { id: 11, type: 'mutation', path: 'batch.2', input: 'data' };
      const mockResponse: BatchResponsePayload = [
        { id: 10, result: { type: 'data', data: 'res1' } },
        { id: 11, result: { type: 'data', data: 'res2' } },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        text: async () => JSON.stringify(mockResponse),
      });

      // Make requests - don't await yet
      const promise1 = transport.request(request1);
      const promise2 = transport.request(request2);

      // Should not have been called yet
      expect(mockFetch).not.toHaveBeenCalled();

      // Advance time by the delay
      vi.advanceTimersByTime(delayMs);

      // Now fetch should have been called once with the batch
      expect(mockFetch).toHaveBeenCalledOnce();
      const expectedBatchPayload = [request1, request2];
      expect(mockFetch).toHaveBeenCalledWith(`${testUrl}/batch`, { // Check batch URL
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(expectedBatchPayload),
      });

      // Await promises to ensure they resolve correctly
      const results = await Promise.all([promise1, promise2]);
      expect(results[0]).toEqual(mockResponse[0]);
      expect(results[1]).toEqual(mockResponse[1]);
    });

    it('should use default delay (0ms) if batching is true', async () => {
        const transport = createHttpTransport({ url: testUrl, batching: true });
        const request1: ProcedureCallMessage = { id: 20, type: 'query', path: 'batch.zero.1' };
        const mockResponse: BatchResponsePayload = [
            { id: 20, result: { type: 'data', data: 'resZero' } },
        ];

        mockFetch.mockResolvedValueOnce({
            ok: true, status: 200, json: async () => mockResponse, text: async () => JSON.stringify(mockResponse),
        });

        const promise1 = transport.request(request1);
        expect(mockFetch).not.toHaveBeenCalled(); // Not called synchronously

        // Advance time just enough to trigger microtask/0ms timeout
        await vi.advanceTimersByTimeAsync(0); // Or vi.runAllTimersAsync()

        expect(mockFetch).toHaveBeenCalledOnce();
        await promise1; // Ensure resolution
    });

    it('should handle batch responses with partial errors', async () => {
      const delayMs = 50;
      const transport = createHttpTransport({ url: testUrl, batching: { delayMs } });
      const request1: ProcedureCallMessage = { id: 30, type: 'query', path: 'batch.ok' };
      const request2: ProcedureCallMessage = { id: 31, type: 'query', path: 'batch.err' };
      const mockResponse: BatchResponsePayload = [
        { id: 30, result: { type: 'data', data: 'resOk' } },
        { id: 31, result: { type: 'error', error: { message: 'Procedure failed', code: 'INTERNAL_SERVER_ERROR' } } },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200, json: async () => mockResponse, text: async () => JSON.stringify(mockResponse),
      });

      const promise1 = transport.request(request1);
      const promise2 = transport.request(request2);

      vi.advanceTimersByTime(delayMs);

      // Check resolution and rejection
      await expect(promise1).resolves.toEqual(mockResponse[0]);
      // Use a type guard before accessing .error
      const errorResult = mockResponse[1].result;
      if (errorResult.type === 'error') {
          await expect(promise2).rejects.toEqual(errorResult.error);
      } else {
          // This case should not happen based on the mock setup, but handle defensively
          expect.fail('Expected second response result type to be "error"');
      }


      expect(mockFetch).toHaveBeenCalledOnce(); // Ensure only one batch call
    });

    it('should reject all promises if batch response length mismatches request length', async () => {
        const delayMs = 50;
        const transport = createHttpTransport({ url: testUrl, batching: { delayMs } });
        const request1: ProcedureCallMessage = { id: 40, type: 'query', path: 'batch.mismatch.1' };
        const request2: ProcedureCallMessage = { id: 41, type: 'query', path: 'batch.mismatch.2' };
        // Simulate server returning only one result for two requests
        const mockResponse: BatchResponsePayload = [
            { id: 40, result: { type: 'data', data: 'res1' } },
        ];

        mockFetch.mockResolvedValueOnce({
            ok: true, status: 200, json: async () => mockResponse, text: async () => JSON.stringify(mockResponse),
        });

        const promise1 = transport.request(request1);
        const promise2 = transport.request(request2);

        vi.advanceTimersByTime(delayMs);

        // Expect both promises to reject with a specific error message
        const expectedErrorMsg = `Batch response length (1) does not match request length (2)`;
        await expect(promise1).rejects.toThrow(expectedErrorMsg);
        await expect(promise2).rejects.toThrow(expectedErrorMsg);

        expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('should reject all promises if the batch fetch itself fails (non-OK response)', async () => {
        const delayMs = 50;
        const transport = createHttpTransport({ url: testUrl, batching: { delayMs } });
        const request1: ProcedureCallMessage = { id: 50, type: 'query', path: 'batch.fail.1' };
        const request2: ProcedureCallMessage = { id: 51, type: 'query', path: 'batch.fail.2' };
        const errorBody = { message: 'Server exploded' };

        mockFetch.mockResolvedValueOnce({
            ok: false, status: 500, statusText: 'Internal Server Error',
            json: async () => errorBody, text: async () => JSON.stringify(errorBody),
        });

        const promise1 = transport.request(request1);
        const promise2 = transport.request(request2);

        vi.advanceTimersByTime(delayMs);

        // Expect both promises to reject with an HttpError reflecting the batch failure
        await expect(promise1).rejects.toBeInstanceOf(HttpError);
        await expect(promise2).rejects.toBeInstanceOf(HttpError);

        // Optionally check the error details on one of them
        try {
            await promise1;
        } catch (e) {
            const httpError = e as HttpError;
            expect(httpError.status).toBe(500);
            expect(httpError.statusText).toBe('Internal Server Error');
            expect(httpError.body).toEqual(errorBody);
            expect(httpError.message).toContain('HTTP Batch Error 500');
        }

        expect(mockFetch).toHaveBeenCalledOnce();
    });

it('should reject all promises if the batch fetch itself encounters a network error', async () => {
    const delayMs = 50;
    const transport = createHttpTransport({ url: testUrl, batching: { delayMs } });
    const request1: ProcedureCallMessage = { id: 60, type: 'query', path: 'batch.neterr.1' };
    const request2: ProcedureCallMessage = { id: 61, type: 'query', path: 'batch.neterr.2' };
    const networkError = new Error('Failed to connect');

    mockFetch.mockRejectedValueOnce(networkError); // Simulate fetch throwing an error

    const promise1 = transport.request(request1);
    const promise2 = transport.request(request2);

    vi.advanceTimersByTime(delayMs);

    // Expect both promises to reject with the network error (or a wrapped version)
    // The current implementation wraps it in a generic 'Batch request failed' error
    await expect(promise1).rejects.toThrow('Batch request failed');
    await expect(promise2).rejects.toThrow('Batch request failed');

    // Check the underlying error if needed (depends on implementation detail)
    try {
        await promise1;
    } catch (e: any) {
        // Check if the original error is somehow attached or if it's just the generic message
        // This assertion might need adjustment based on how errors are wrapped/propagated
        expect(e.message).toBe('Batch request failed');
    }


    expect(mockFetch).toHaveBeenCalledOnce();
});


    it('should reset the timer if new requests arrive within the delay window', async () => {
        const delayMs = 100;
        const transport = createHttpTransport({ url: testUrl, batching: { delayMs } });
        const request1: ProcedureCallMessage = { id: 70, type: 'query', path: 'batch.timer.1' };
        const request2: ProcedureCallMessage = { id: 71, type: 'query', path: 'batch.timer.2' };
        const mockResponse: BatchResponsePayload = [
            { id: 70, result: { type: 'data', data: 'timer1' } },
            { id: 71, result: { type: 'data', data: 'timer2' } },
        ];

        mockFetch.mockResolvedValueOnce({
            ok: true, status: 200, json: async () => mockResponse, text: async () => JSON.stringify(mockResponse),
        });

        // First request
        const promise1 = transport.request(request1);
        expect(mockFetch).not.toHaveBeenCalled();

        // Advance time, but less than the delay
        vi.advanceTimersByTime(delayMs / 2);
        expect(mockFetch).not.toHaveBeenCalled();

        // Second request arrives, should reset timer
        const promise2 = transport.request(request2);
        expect(mockFetch).not.toHaveBeenCalled();

        // Advance time by the full delay *now*
        vi.advanceTimersByTime(delayMs);

        // Should have been called only ONCE with both requests
        expect(mockFetch).toHaveBeenCalledOnce();
        const expectedBatchPayload = [request1, request2];
        expect(mockFetch).toHaveBeenCalledWith(`${testUrl}/batch`, expect.objectContaining({
            body: JSON.stringify(expectedBatchPayload),
        }));

        // Ensure promises resolve
        await Promise.all([promise1, promise2]);
    });
  }); // End of 'request method with batching enabled' describe


  describe('subscribe method', () => {
    it('should throw an error when called', () => {
      const transport = createHttpTransport({ url: testUrl });
      const subscribePayload: SubscribeMessage = {
        id: 100,
        type: 'subscription',
        path: 'test.onUpdate',
      };

      expect(() => transport.subscribe(subscribePayload)).toThrow(
        'Subscriptions are not supported over standard HTTP transport.'
      );
    });
  });
});
