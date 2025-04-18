import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSubscriptionManager, type SubscriptionManager } from './subscriptionManager';
import type { VSCodePostMessage, SubscribeMessage, SubscriptionDataMessage, SubscriptionErrorMessage, RequestMissingMessage } from './types';
import { TypeQLClientError } from './types';

// Helper to advance timers and microtasks
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('createSubscriptionManager', () => {
    let subscriptionManager: SubscriptionManager;
    let mockVscodeApi: VSCodePostMessage;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleDebugSpy: ReturnType<typeof vi.spyOn>;


    beforeEach(() => {
        mockVscodeApi = {
            postMessage: vi.fn(),
            // onDidReceiveMessage is not used by the manager itself
            onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
        };
        subscriptionManager = createSubscriptionManager({ vscodeApi: mockVscodeApi });
        // Spy on console messages to verify warnings/errors without polluting test output
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {}); // Optional: spy on debug too
    });

    afterEach(() => {
        // Restore console spies
        consoleWarnSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        consoleDebugSpy.mockRestore();
        // Ensure all subscriptions are ended to prevent leaks between tests
        subscriptionManager.endAll();
    });

    describe('create', () => {
        const subMessage: SubscribeMessage = { type: 'subscription', id: 'sub-1', path: 'test.path', input: 'test' }; // Changed query to input

        it('should throw error if subscription message has no ID', () => {
            // Correctly type the invalid message and ensure path is also missing for the test
            const invalidMessage = { type: 'subscription', path: 'test.path', input: 'test' } as Omit<SubscribeMessage, 'id'> as SubscribeMessage; // Changed query to input
            expect(() => subscriptionManager.create(invalidMessage)).toThrow(TypeQLClientError);
            expect(() => subscriptionManager.create(invalidMessage)).toThrow('Subscription message must have an ID.');
        });

        it('should send subscribe message via postMessage', () => {
            subscriptionManager.create(subMessage);
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(subMessage);
        });

        it('should return an object with iterator and unsubscribe function', () => {
            const result = subscriptionManager.create(subMessage);
            expect(result).toHaveProperty('iterator');
            expect(result.iterator[Symbol.asyncIterator]).toBeInstanceOf(Function);
            expect(result).toHaveProperty('unsubscribe');
            expect(result.unsubscribe).toBeInstanceOf(Function);
        });

        it('should throw and cleanup if postMessage fails during creation', () => {
            const postMessageError = new Error('PostMessage Failed');
            mockVscodeApi.postMessage = vi.fn(() => { throw postMessageError; });

            expect(() => subscriptionManager.create(subMessage)).toThrow(TypeQLClientError);
            expect(() => subscriptionManager.create(subMessage)).toThrow(`VSCode postMessage failed for subscribe: ${postMessageError.message}`);
            expect(subscriptionManager.hasSubscription('sub-1')).toBe(false); // Ensure cleanup happened
        });

        it('should warn and end previous subscription if ID already exists', () => {
            const firstResult = subscriptionManager.create(subMessage);
            const secondResult = subscriptionManager.create(subMessage); // Create again with same ID

            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Subscription with ID sub-1 already exists. Ending previous one.'));
            expect(subscriptionManager.hasSubscription('sub-1')).toBe(true); // Should still have the *new* one

            // Verify the first iterator is ended (optional but good)
            // This requires consuming the iterator slightly
            // const firstNext = await firstResult.iterator.next();
            // expect(firstNext.done).toBe(true); // Check if it ended immediately
        });
    });

    describe('iterator', () => {
        const subMessage: SubscribeMessage = { type: 'subscription', id: 'sub-iter', path: 'test.path', input: 'test' }; // Changed query to input

        it('should yield messages pushed via pushData', async () => {
            const { iterator } = subscriptionManager.create(subMessage);
            const dataMessage: SubscriptionDataMessage = { type: 'subscriptionData', id: 'sub-iter', serverSeq: 1, data: { payload: 'one' } };
            const dataMessage2: SubscriptionDataMessage = { type: 'subscriptionData', id: 'sub-iter', serverSeq: 2, data: { payload: 'two' } };

            subscriptionManager.pushData('sub-iter', dataMessage);
            subscriptionManager.pushData('sub-iter', dataMessage2);

            const result1 = await iterator.next();
            expect(result1.done).toBe(false);
            expect(result1.value).toEqual(dataMessage);

            const result2 = await iterator.next();
            expect(result2.done).toBe(false);
            expect(result2.value).toEqual(dataMessage2);
        });

        it('should yield error messages pushed via pushData', async () => {
            const { iterator } = subscriptionManager.create(subMessage);
            const errorMessage: SubscriptionErrorMessage = { type: 'subscriptionError', id: 'sub-iter', error: { message: 'Test Error' } };

            subscriptionManager.pushData('sub-iter', errorMessage);

            const result = await iterator.next();
            expect(result.done).toBe(false);
            expect(result.value).toEqual(errorMessage);
        });

        it('should wait if queue is empty and continue when data arrives', async () => {
            const { iterator } = subscriptionManager.create(subMessage);
            const dataMessage: SubscriptionDataMessage = { type: 'subscriptionData', id: 'sub-iter', serverSeq: 1, data: { payload: 'waited' } };

            let resultPromise = iterator.next();
            await tick(); // Allow iterator to reach await point

            // Push data *after* iterator started waiting
            subscriptionManager.pushData('sub-iter', dataMessage);

            const result = await resultPromise; // Now the promise should resolve
            expect(result.done).toBe(false);
            expect(result.value).toEqual(dataMessage);
        });

        it('should terminate when endSubscription is called', async () => {
            const { iterator } = subscriptionManager.create(subMessage);

            let resultPromise = iterator.next();
            await tick(); // Allow iterator to reach await point

            subscriptionManager.endSubscription('sub-iter');

            const result = await resultPromise; // Promise resolves because end was called
            expect(result.done).toBe(true);
            expect(result.value).toBeUndefined();
            expect(subscriptionManager.hasSubscription('sub-iter')).toBe(false); // Verify cleanup
        });

        it('should terminate when unsubscribe is called', async () => {
            const { iterator, unsubscribe } = subscriptionManager.create(subMessage);

            let resultPromise = iterator.next();
            await tick(); // Allow iterator to reach await point

            unsubscribe(); // Call the unsubscribe function

            const result = await resultPromise; // Promise resolves because end was called internally
            expect(result.done).toBe(true);
            expect(result.value).toBeUndefined();
            expect(subscriptionManager.hasSubscription('sub-iter')).toBe(false); // Verify cleanup
        });

         it('should handle push after end gracefully (no yield)', async () => {
            const { iterator } = subscriptionManager.create(subMessage);
            const dataMessage: SubscriptionDataMessage = { type: 'subscriptionData', id: 'sub-iter', serverSeq: 1, data: { payload: 'late' } };

            subscriptionManager.endSubscription('sub-iter');
            await tick(); // Ensure end processing completes

            subscriptionManager.pushData('sub-iter', dataMessage); // Push after end

            const result = await iterator.next(); // Should already be done
            expect(result.done).toBe(true);
        });
    });

    describe('unsubscribe', () => {
        const subMessage: SubscribeMessage = { type: 'subscription', id: 'sub-unsub', path: 'test.path', input: 'test' }; // Changed query to input

        it('should call endSubscription locally and send stop message', () => {
            const { unsubscribe } = subscriptionManager.create(subMessage);
            const endSpy = vi.spyOn(subscriptionManager, 'endSubscription'); // Spy on the public method

            unsubscribe();

            // Check local end was triggered (implicitly via internal end())
            // We can check if the subscription is gone
            expect(subscriptionManager.hasSubscription('sub-unsub')).toBe(false);

            // Check stop message sent
            const expectedStopMessage = { type: 'subscriptionStop', id: 'sub-unsub' };
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(expectedStopMessage);

            endSpy.mockRestore();
        });

        it('should handle multiple calls gracefully', () => {
            const { unsubscribe } = subscriptionManager.create(subMessage);
            unsubscribe(); // First call
            unsubscribe(); // Second call

            // Should only send stop message once
            const expectedStopMessage = { type: 'subscriptionStop', id: 'sub-unsub' };
            expect(mockVscodeApi.postMessage).toHaveBeenCalledTimes(2); // Once for subscribe, once for stop
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(expectedStopMessage);
            expect(subscriptionManager.hasSubscription('sub-unsub')).toBe(false);
        });

        it('should log error if postMessage fails during unsubscribe', () => {
            const { unsubscribe } = subscriptionManager.create(subMessage);
            const postMessageError = new Error('Stop Failed');
            // Mock postMessage to fail only for the stop message
            mockVscodeApi.postMessage = vi.fn((msg) => {
                if (msg.type === 'subscriptionStop') {
                    throw postMessageError;
                }
            });

            unsubscribe();

            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send unsubscribe message'), postMessageError);
            expect(subscriptionManager.hasSubscription('sub-unsub')).toBe(false); // Local state should still be cleaned up
        });
    });

    describe('pushData', () => {
        it('should warn when pushing to non-existent subscription', () => {
            const dataMessage: SubscriptionDataMessage = { type: 'subscriptionData', id: 'sub-nonexistent', serverSeq: 1, data: {} };
            subscriptionManager.pushData('sub-nonexistent', dataMessage);
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Attempted to push data to non-existent subscription ID'));
        });
    });

    describe('endSubscription', () => {
        it('should warn when ending non-existent subscription', () => {
            subscriptionManager.endSubscription('sub-nonexistent');
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Attempted to end non-existent subscription ID'));
        });
    });

    describe('endAll', () => {
        it('should end all active subscriptions', () => {
            const sub1 = subscriptionManager.create({ type: 'subscription', id: 'sub-all-1', path: 'test.path1', input: 'q1' }); // Changed query to input
            const sub2 = subscriptionManager.create({ type: 'subscription', id: 'sub-all-2', path: 'test.path2', input: 'q2' }); // Changed query to input

            expect(subscriptionManager.hasSubscription('sub-all-1')).toBe(true);
            expect(subscriptionManager.hasSubscription('sub-all-2')).toBe(true);

            subscriptionManager.endAll();

            expect(subscriptionManager.hasSubscription('sub-all-1')).toBe(false);
            expect(subscriptionManager.hasSubscription('sub-all-2')).toBe(false);
            expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Ending all (2) active subscriptions'));

            // Optional: Check if iterators are done
            // const next1 = await sub1.iterator.next();
            // const next2 = await sub2.iterator.next();
            // expect(next1.done).toBe(true);
            // expect(next2.done).toBe(true);
        });
    });

     describe('requestMissing', () => {
        it('should send request_missing message via postMessage', () => {
            const subId = 'sub-miss';
            const fromSeq = 5;
            const toSeq = 10;
            subscriptionManager.requestMissing(subId, fromSeq, toSeq);

            const expectedMessage: RequestMissingMessage = {
                type: 'request_missing',
                id: subId,
                fromSeq: fromSeq,
                toSeq: toSeq
            };
            expect(mockVscodeApi.postMessage).toHaveBeenCalledWith(expectedMessage);
        });

        it('should log error if postMessage fails', () => {
             const subId = 'sub-miss-fail';
             const postMessageError = new Error('Request Missing Failed');
             mockVscodeApi.postMessage = vi.fn(() => { throw postMessageError; });

             subscriptionManager.requestMissing(subId, 1, 5);

             expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(`Failed to send request_missing message for sub ${subId}`), postMessageError);
        });
    });
});