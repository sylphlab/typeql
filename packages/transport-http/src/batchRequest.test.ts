import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { createBatchProcessor } from './batchRequest';
import { TypeQLClientError } from '@sylphlab/typeql-shared';
import type { ProcedureCallMessage, ProcedureResultMessage } from '@sylphlab/typeql-shared';

// Mock fetch and timers
const mockFetch = vi.fn();
const mockGetHeaders = vi.fn();
vi.useFakeTimers();

// Replace global fetch with mock before each test
beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockGetHeaders.mockResolvedValue({ 'Content-Type': 'application/json' }); // Default mock
});

// Restore global fetch and timers after each test
afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.clearAllTimers();
});

describe('createBatchProcessor', () => {
    const testUrl = 'http://localhost:3000/typeql/batch';
    const batchDelayMs = 50;

    const createMessage = (id: number): ProcedureCallMessage => ({
        id: `req-${id}`,
        type: 'query',
        path: `getPath${id}`,
        input: { value: id },
    });

    const createSuccessResult = (id: number): ProcedureResultMessage => ({
        id: `req-${id}`,
        result: { type: 'data', data: { resultValue: id * 2 } },
    });

    it('should queue requests and send them as a batch after delay', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const msg2 = createMessage(2);
        const result1 = createSuccessResult(1);
        const result2 = createSuccessResult(2);

        const promise1 = processor.queueRequest(msg1);
        const promise2 = processor.queueRequest(msg2);

        // Should not have fetched yet
        expect(mockFetch).not.toHaveBeenCalled();
        expect(processor.hasPending()).toBe(true);

        // Mock successful batch response
        const mockResponse = new Response(JSON.stringify([result1, result2]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
        mockFetch.mockResolvedValue(mockResponse);

        // Advance timers past the delay
        vi.advanceTimersByTime(batchDelayMs + 10);

        // Wait for the promises to resolve
        const results = await Promise.all([promise1, promise2]);

        expect(mockGetHeaders).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(testUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([msg1, msg2]),
        });
        expect(results).toEqual([result1, result2]);
        expect(processor.hasPending()).toBe(false);
    });

    it('should reset timer if new request comes before delay expires', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const msg2 = createMessage(2);

        processor.queueRequest(msg1);
        vi.advanceTimersByTime(batchDelayMs / 2); // Halfway
        processor.queueRequest(msg2); // This should reset the timer

        // Should not have fetched yet
        expect(mockFetch).not.toHaveBeenCalled();

        // Advance timers again, but not enough for the reset timer
        vi.advanceTimersByTime(batchDelayMs / 2 - 1);
        expect(mockFetch).not.toHaveBeenCalled();

        // Advance timer past the full delay from the *second* request
        vi.advanceTimersByTime(batchDelayMs / 2 + 1);

        // Now it should have fetched
        expect(mockFetch).toHaveBeenCalledTimes(1);
        // Don't need to await results here, just checking the fetch call timing
    });

    it('should reject all promises in batch if fetch fails', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const msg2 = createMessage(2);
        const networkError = new Error('Batch network failed');
        mockFetch.mockRejectedValue(networkError);

        const promise1 = processor.queueRequest(msg1);
        const promise2 = processor.queueRequest(msg2);

        vi.advanceTimersByTime(batchDelayMs + 10);

        await expect(promise1).rejects.toThrow(TypeQLClientError);
        await expect(promise1).rejects.toThrow(/Network request failed for batch: Batch network failed/);
        await expect(promise2).rejects.toThrow(TypeQLClientError);
        await expect(promise2).rejects.toThrow(/Network request failed for batch: Batch network failed/);

        expect(mockGetHeaders).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(processor.hasPending()).toBe(false); // Queue should be cleared even on failure
    });

    it('should reject all promises in batch if response status is not ok', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const msg2 = createMessage(2);
        const mockResponse = new Response('Server Error', { status: 500, statusText: 'Internal Error' });
        mockFetch.mockResolvedValue(mockResponse);

        const promise1 = processor.queueRequest(msg1);
        const promise2 = processor.queueRequest(msg2);

        vi.advanceTimersByTime(batchDelayMs + 10);

        await expect(promise1).rejects.toThrow(TypeQLClientError);
        await expect(promise1).rejects.toThrow(/Batch request failed: Internal Error \(500\) - Server Error/);
        await expect(promise1).rejects.toHaveProperty('cause', '500');
        await expect(promise2).rejects.toThrow(TypeQLClientError);
        await expect(promise2).rejects.toThrow(/Batch request failed: Internal Error \(500\) - Server Error/);

        expect(mockGetHeaders).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(processor.hasPending()).toBe(false);
    });

     it('should reject all promises if response is not a JSON array', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const mockResponse = new Response(JSON.stringify({ message: 'not an array' }), { status: 200 });
        mockFetch.mockResolvedValue(mockResponse);

        const promise1 = processor.queueRequest(msg1);
        vi.advanceTimersByTime(batchDelayMs + 10);

        await expect(promise1).rejects.toThrow(TypeQLClientError);
        await expect(promise1).rejects.toThrow('Invalid batch response format: expected an array.');
        expect(processor.hasPending()).toBe(false);
    });

     it('should reject all promises if response array length mismatches request length', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const msg2 = createMessage(2); // Sent 2 requests
        const result1 = createSuccessResult(1); // But only got 1 response
        const mockResponse = new Response(JSON.stringify([result1]), { status: 200 });
        mockFetch.mockResolvedValue(mockResponse);

        const promise1 = processor.queueRequest(msg1);
        const promise2 = processor.queueRequest(msg2);
        vi.advanceTimersByTime(batchDelayMs + 10);

        await expect(promise1).rejects.toThrow(TypeQLClientError);
        await expect(promise1).rejects.toThrow('Mismatched batch response length: expected 2, got 1');
        await expect(promise2).rejects.toThrow(TypeQLClientError); // Both should reject
        await expect(promise2).rejects.toThrow('Mismatched batch response length: expected 2, got 1');
        expect(processor.hasPending()).toBe(false);
    });

    it('should resolve/reject individual promises based on batch response content', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const msg2 = createMessage(2); // Valid
        const msg3 = createMessage(3); // Invalid structure in response
        const result1 = createSuccessResult(1);
        const errorResult2: ProcedureResultMessage = { id: 'req-2', result: { type: 'error', error: { message: 'Specific error', code: 'ERR_CODE' } } };
        const invalidResult3 = { id: 'req-3', /* missing result field */ data: 'invalid' };

        const mockResponse = new Response(JSON.stringify([result1, errorResult2, invalidResult3]), { status: 200 });
        mockFetch.mockResolvedValue(mockResponse);

        const promise1 = processor.queueRequest(msg1);
        const promise2 = processor.queueRequest(msg2);
        const promise3 = processor.queueRequest(msg3);

        vi.advanceTimersByTime(batchDelayMs + 10);

        // Check results individually
        await expect(promise1).resolves.toEqual(result1);
        await expect(promise2).resolves.toEqual(errorResult2); // Resolves even with error type result
        await expect(promise3).rejects.toThrow(TypeQLClientError);
        await expect(promise3).rejects.toThrow(/Invalid result format in batch response for ID req-3/);

        expect(processor.hasPending()).toBe(false);
    });

    it('should handle ID mismatch with a warning but resolve based on index', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const msg2 = createMessage(2);
        const result1_wrongId = { id: 'req-WRONG', result: { type: 'data', data: { resultValue: 2 } } }; // ID mismatch
        const result2 = createSuccessResult(2);

        const mockResponse = new Response(JSON.stringify([result1_wrongId, result2]), { status: 200 });
        mockFetch.mockResolvedValue(mockResponse);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); // Suppress console warn

        const promise1 = processor.queueRequest(msg1);
        const promise2 = processor.queueRequest(msg2);

        vi.advanceTimersByTime(batchDelayMs + 10);

        await expect(promise1).resolves.toEqual(result1_wrongId); // Resolves with the mismatched data based on index
        await expect(promise2).resolves.toEqual(result2);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Batch response ID mismatch at index 0: expected req-1, got req-WRONG'));

        warnSpy.mockRestore();
        expect(processor.hasPending()).toBe(false);
    });

     it('flushQueue should send pending requests immediately', async () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        const msg1 = createMessage(1);
        const result1 = createSuccessResult(1);
        const mockResponse = new Response(JSON.stringify([result1]), { status: 200 });
        mockFetch.mockResolvedValue(mockResponse);

        const promise1 = processor.queueRequest(msg1);
        expect(mockFetch).not.toHaveBeenCalled(); // Not called yet

        processor.flushQueue(); // Force send

        expect(mockFetch).toHaveBeenCalledTimes(1); // Called immediately
        await expect(promise1).resolves.toEqual(result1);
        expect(processor.hasPending()).toBe(false);

        // Ensure timer is cleared
        vi.advanceTimersByTime(batchDelayMs + 10);
        expect(mockFetch).toHaveBeenCalledTimes(1); // Should not call again
    });

     it('hasPending should return correct status', () => {
        const processor = createBatchProcessor(testUrl, mockFetch, mockGetHeaders, batchDelayMs);
        expect(processor.hasPending()).toBe(false);
        processor.queueRequest(createMessage(1));
        expect(processor.hasPending()).toBe(true);
        vi.advanceTimersByTime(batchDelayMs + 10);
        // Need to await the processing if fetch was mocked to resolve
        // For simplicity here, just check state after queuing
        expect(processor.hasPending()).toBe(true); // Still true until processBatch clears it
    });

});