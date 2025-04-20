import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpTransport, HttpError } from './index'; // Adjust path if needed
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

  });

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
