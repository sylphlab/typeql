import { describe, it, expect, vi, beforeEach, afterEach, MockedFunction } from 'vitest';
import { createHttpTransport } from './index';
import type { HttpTransportOptions } from './types';
import type { ProcedureCallMessage, ProcedureResultMessage, SubscribeMessage, AckMessage } from '@sylphlab/typeql-shared'; // Added AckMessage
import { TypeQLClientError } from '@sylphlab/typeql-shared';

// Mock dependencies using vi.mock
vi.mock('./headers');
vi.mock('./singleRequest');
vi.mock('./batchRequest');

// Import the mocked functions/classes AFTER vi.mock
import { createHeaderGetter } from './headers';
import { sendSingleRequest } from './singleRequest';
import { createBatchProcessor } from './batchRequest';

// Typecast the mocked imports
const mockCreateHeaderGetter = createHeaderGetter as MockedFunction<typeof createHeaderGetter>;
const mockSendSingleRequest = sendSingleRequest as MockedFunction<typeof sendSingleRequest>;
const mockCreateBatchProcessor = createBatchProcessor as MockedFunction<typeof createBatchProcessor>;

// Mock fetch globally for simplicity in options default
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock implementations returned by the factory mocks
const mockGetHeadersFn = vi.fn().mockResolvedValue({ 'Content-Type': 'application/json' });
const mockQueueRequestFn = vi.fn();
const mockFlushQueueFn = vi.fn();
const mockHasPendingFn = vi.fn().mockReturnValue(false);
const mockBatchProcessorInstance = {
    queueRequest: mockQueueRequestFn,
    flushQueue: mockFlushQueueFn,
    hasPending: mockHasPendingFn,
};

beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    vi.resetAllMocks(); // Ensure mocks are reset

    // Set up default mock implementations for the factories
    mockCreateHeaderGetter.mockReturnValue(mockGetHeadersFn);
    mockSendSingleRequest.mockResolvedValue({ id: 'default-single', result: { type: 'data', data: 'ok' } }); // Default success for single
    mockCreateBatchProcessor.mockReturnValue(mockBatchProcessorInstance);
    mockQueueRequestFn.mockResolvedValue({ id: 'default-batch', result: { type: 'data', data: 'batch ok' } }); // Default success for batch queue
    mockHasPendingFn.mockReturnValue(false); // Default no pending
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createHttpTransport', () => {
    const testUrl = 'http://localhost:4000/api';
    const testMessage: ProcedureCallMessage = { id: 'msg-1', type: 'query', path: 'test', input: null };

    it('should create a transport object', () => {
        const options: HttpTransportOptions = { url: testUrl };
        const transport = createHttpTransport(options);
        expect(transport).toBeDefined();
        expect(transport.request).toBeInstanceOf(Function);
        expect(transport.subscribe).toBeInstanceOf(Function);
        expect(transport.onAckReceived).toBeInstanceOf(Function);
        expect(transport.requestMissingDeltas).toBeInstanceOf(Function);
    });

    it('should use default fetch if none provided', () => {
        const options: HttpTransportOptions = { url: testUrl };
        createHttpTransport(options);
        // Check if createHeaderGetter was called (indirectly checks options processing)
        expect(mockCreateHeaderGetter).toHaveBeenCalledWith(expect.objectContaining({ headers: undefined }));
        // Further checks might involve calling request and seeing if the default fetch mock was used internally by sendSingleRequest/createBatchProcessor
    });

    it('should pass custom fetch to dependencies', () => {
        const customFetch = vi.fn();
        const options: HttpTransportOptions = { url: testUrl, fetch: customFetch };
        createHttpTransport(options);

        // Expect factories to be called with the custom fetch
        expect(mockCreateHeaderGetter).toHaveBeenCalled(); // Called regardless of fetch
        // If batching is off by default, singleRequest would be used
        // If batching is on, batchProcessor would be created
        // We need to test both scenarios or check how dependencies receive fetch

        // Test without batching:
        const transport = createHttpTransport({ ...options, batching: false });
        transport.request(testMessage);
        expect(mockSendSingleRequest).toHaveBeenCalledWith(
            expect.anything(), // message
            testUrl,
            customFetch, // Check if custom fetch is passed
            expect.any(Function) // getHeaders function
        );

         // Test with batching:
         const transportBatch = createHttpTransport({ ...options, batching: true });
         expect(mockCreateBatchProcessor).toHaveBeenCalledWith(
             testUrl,
             customFetch, // Check if custom fetch is passed
             expect.any(Function), // getHeaders function
             expect.any(Number) // delayMs
         );
    });

    describe('request handling (no batching)', () => {
        it('should call sendSingleRequest when batching is false', async () => {
            const options: HttpTransportOptions = { url: testUrl, batching: false };
            const transport = createHttpTransport(options);
            const expectedResult: ProcedureResultMessage = { id: testMessage.id, result: { type: 'data', data: 'single result' } };
            mockSendSingleRequest.mockResolvedValueOnce(expectedResult);

            const result = await transport.request(testMessage);

            expect(mockCreateBatchProcessor).not.toHaveBeenCalled();
            expect(mockSendSingleRequest).toHaveBeenCalledTimes(1);
            expect(mockSendSingleRequest).toHaveBeenCalledWith(testMessage, testUrl, mockFetch, mockGetHeadersFn);
            expect(result).toEqual(expectedResult);
        });

         it('should call sendSingleRequest when batching delay is 0 or less', async () => {
            const options: HttpTransportOptions = { url: testUrl, batching: { delayMs: 0 } };
            const transport = createHttpTransport(options);
            await transport.request(testMessage);
            expect(mockSendSingleRequest).toHaveBeenCalledTimes(1);

            vi.clearAllMocks(); // Reset for next check

            const optionsNegative: HttpTransportOptions = { url: testUrl, batching: { delayMs: -10 } };
            const transportNegative = createHttpTransport(optionsNegative);
            await transportNegative.request(testMessage);
            expect(mockSendSingleRequest).toHaveBeenCalledTimes(1);
            expect(mockCreateBatchProcessor).not.toHaveBeenCalled();
        });

        it('should flush pending batch queue if switching from batching to non-batching (edge case)', async () => {
             // Simulate batch processor was created and has pending items
             mockHasPendingFn.mockReturnValueOnce(true);
             mockCreateBatchProcessor.mockReturnValueOnce(mockBatchProcessorInstance);

             // Create transport initially *as if* batching was enabled
             const transportInitialBatch = createHttpTransport({ url: testUrl, batching: true });

             // Now, create transport *without* batching
             const transportNoBatch = createHttpTransport({ url: testUrl, batching: false });
             await transportNoBatch.request(testMessage); // Make a request

             // Expect the flush function to have been called before sendSingleRequest
             expect(mockFlushQueueFn).toHaveBeenCalledTimes(1);
             expect(mockSendSingleRequest).toHaveBeenCalledTimes(1); // Called for the current request
        });
    });

    describe('request handling (with batching)', () => {
        const batchOptions: HttpTransportOptions = { url: testUrl, batching: true }; // Default delay
        const batchOptionsSpecific: HttpTransportOptions = { url: testUrl, batching: { delayMs: 100 } };

        it('should create batch processor when batching is enabled', () => {
            createHttpTransport(batchOptions);
            expect(mockCreateBatchProcessor).toHaveBeenCalledTimes(1);
            expect(mockCreateBatchProcessor).toHaveBeenCalledWith(testUrl, mockFetch, mockGetHeadersFn, 10); // Default delay

            vi.clearAllMocks();
            mockCreateHeaderGetter.mockReturnValue(mockGetHeadersFn); // Reset mock return value if needed

            createHttpTransport(batchOptionsSpecific);
            expect(mockCreateBatchProcessor).toHaveBeenCalledTimes(1);
            expect(mockCreateBatchProcessor).toHaveBeenCalledWith(testUrl, mockFetch, mockGetHeadersFn, 100); // Specific delay
        });

        it('should call batchProcessor.queueRequest when batching is enabled', async () => {
            const transport = createHttpTransport(batchOptions);
            const expectedResult: ProcedureResultMessage = { id: testMessage.id, result: { type: 'data', data: 'batch result' } };
            mockQueueRequestFn.mockResolvedValueOnce(expectedResult);

            const result = await transport.request(testMessage);

            expect(mockSendSingleRequest).not.toHaveBeenCalled();
            expect(mockQueueRequestFn).toHaveBeenCalledTimes(1);
            expect(mockQueueRequestFn).toHaveBeenCalledWith(testMessage);
            expect(result).toEqual(expectedResult);
        });
    });

    describe('unsupported operations', () => {
        it('subscribe should throw TypeQLClientError', () => {
            const options: HttpTransportOptions = { url: testUrl };
            const transport = createHttpTransport(options);
            const subMessage: SubscribeMessage = { id: 'sub-1', type: 'subscription', path: 'updates', input: null }; // Removed batch property

            expect(() => transport.subscribe(subMessage)).toThrow(TypeQLClientError);
            expect(() => transport.subscribe(subMessage)).toThrow(/Subscriptions require a persistent connection/);
        });

        it('requestMissingDeltas should log error', () => {
            const options: HttpTransportOptions = { url: testUrl };
            const transport = createHttpTransport(options);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            transport.requestMissingDeltas!('sub-1', 10, 20); // Added non-null assertion
            expect(errorSpy).toHaveBeenCalledWith("[HTTP Transport] Cannot request missing deltas over HTTP transport.");

            errorSpy.mockRestore();
        });

         it('onAckReceived should log warning', () => {
            const options: HttpTransportOptions = { url: testUrl };
            const transport = createHttpTransport(options);
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // Added missing properties clientSeq and serverSeq
            const ackMessage: AckMessage = { type: 'ack', id: 'req-5', clientSeq: 1, serverSeq: 1 };

            transport.onAckReceived!(ackMessage); // Added non-null assertion
            expect(warnSpy).toHaveBeenCalledWith(
                "[HTTP Transport] Received Ack message, but HTTP transport doesn't typically handle these:",
                ackMessage
            );

            warnSpy.mockRestore();
        });
    });

    // Add tests for header handling if createHeaderGetter mock needs verification
    it('should use headers provided by createHeaderGetter', async () => {
         const options: HttpTransportOptions = { url: testUrl, headers: { 'X-Static': 'static' } };
         mockGetHeadersFn.mockResolvedValueOnce({ 'X-Test-Header': 'test-value' });
         mockCreateHeaderGetter.mockReturnValueOnce(mockGetHeadersFn); // Ensure this specific mock is returned

         const transport = createHttpTransport(options);
         await transport.request(testMessage); // Assuming no batching for simplicity

         expect(mockCreateHeaderGetter).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'X-Static': 'static' } }));
         expect(mockGetHeadersFn).toHaveBeenCalledTimes(1);
         // Check if sendSingleRequest was called with the function returned by createHeaderGetter
         expect(mockSendSingleRequest).toHaveBeenCalledWith(
             expect.anything(),
             expect.anything(),
             expect.anything(),
             mockGetHeadersFn // Check if the correct function was passed
         );
    });
});