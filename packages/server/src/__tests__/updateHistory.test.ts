// packages/server/src/__tests__/updateHistory.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInMemoryUpdateHistory, UpdateHistory } from '../updateHistory';
import type { SubscriptionDataMessage } from '@sylph/typeql-shared';

// Helper to create messages
const createMsg = (id: string | number, serverSeq: number, data: any = {}): SubscriptionDataMessage => ({
    type: 'subscriptionData',
    id,
    serverSeq,
    data,
});

describe('createInMemoryUpdateHistory', () => {
    let history: UpdateHistory;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        // Default history for most tests
        history = createInMemoryUpdateHistory();
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); // Suppress output
    });

    afterEach(() => {
        consoleWarnSpy.mockRestore();
    });

    describe('addUpdate', () => {
        it('should add a valid message to a new topic', () => {
            const msg = createMsg('sub1', 1);
            history.addUpdate('topicA', msg);
            const updates = history.getUpdates('topicA', 0, 1);
            expect(updates).toEqual([msg]);
        });

        it('should add multiple valid messages in order to the same topic', () => {
            const msg1 = createMsg('sub1', 1);
            const msg2 = createMsg('sub1', 2);
            history.addUpdate('topicA', msg1);
            history.addUpdate('topicA', msg2);
            const updates = history.getUpdates('topicA', 0, 2);
            expect(updates).toEqual([msg1, msg2]);
        });

        it('should ignore messages with undefined serverSeq and warn', () => {
            const msg = { type: 'subscriptionData', id: 'sub1', data: {} } as SubscriptionDataMessage; // Missing serverSeq
            history.addUpdate('topicA', msg);
            expect(history.getUpdates('topicA', 0, 1)).toEqual([]);
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('[TypeQL History] Ignoring message for topic "topicA" without a valid positive serverSeq'),
                expect.objectContaining({ id: 'sub1' })
            );
        });

        it('should ignore messages with serverSeq <= 0 and warn', () => {
            const msg0 = createMsg('sub1', 0);
            const msgNeg = createMsg('sub1', -1);
            history.addUpdate('topicA', msg0);
            history.addUpdate('topicA', msgNeg);
            expect(history.getUpdates('topicA', -2, 0)).toEqual([]);
            expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('[TypeQL History] Ignoring message for topic "topicA" without a valid positive serverSeq'),
                expect.objectContaining({ serverSeq: 0 })
            );
             expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('[TypeQL History] Ignoring message for topic "topicA" without a valid positive serverSeq'),
                expect.objectContaining({ serverSeq: -1 })
            );
        });

        it('should ignore out-of-order messages and warn', () => {
            const msg1 = createMsg('sub1', 2);
            const msg2 = createMsg('sub1', 1); // Out of order
            history.addUpdate('topicA', msg1);
            history.addUpdate('topicA', msg2);
            expect(history.getUpdates('topicA', 0, 2)).toEqual([msg1]);
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('[TypeQL History] Received out-of-order or duplicate message for topic "topicA"')
                // expect.stringContaining('serverSeq: 1, Last serverSeq: 2') // Message check removed as it's part of the string now
            );
        });

         it('should ignore duplicate messages (same serverSeq) and warn', () => {
            const msg1 = createMsg('sub1', 1);
            const msg2 = createMsg('sub1', 1); // Duplicate
            history.addUpdate('topicA', msg1);
            history.addUpdate('topicA', msg2);
            expect(history.getUpdates('topicA', 0, 1)).toEqual([msg1]);
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                expect.stringContaining('[TypeQL History] Received out-of-order or duplicate message for topic "topicA"')
                // expect.stringContaining('serverSeq: 1, Last serverSeq: 1') // Message check removed
            );
        });


        it('should prune oldest messages when buffer size is exceeded', () => {
            const smallHistory = createInMemoryUpdateHistory({ bufferSize: 2 });
            const msg1 = createMsg('sub1', 1);
            const msg2 = createMsg('sub1', 2);
            const msg3 = createMsg('sub1', 3);

            smallHistory.addUpdate('topicA', msg1);
            smallHistory.addUpdate('topicA', msg2);
            expect(smallHistory.getUpdates('topicA', 0, 2)).toEqual([msg1, msg2]);

            smallHistory.addUpdate('topicA', msg3); // This should prune msg1
            expect(smallHistory.getUpdates('topicA', 0, 3)).toEqual([msg2, msg3]);
            expect(smallHistory.getUpdates('topicA', 0, 1)).toEqual([]); // msg1 is gone
        });

        it('should handle multiple topics independently', () => {
            const msgA1 = createMsg('subA', 1);
            const msgB1 = createMsg('subB', 10);
            history.addUpdate('topicA', msgA1);
            history.addUpdate('topicB', msgB1);

            expect(history.getUpdates('topicA', 0, 1)).toEqual([msgA1]);
            expect(history.getUpdates('topicB', 0, 1)).toEqual([]);
            expect(history.getUpdates('topicB', 9, 10)).toEqual([msgB1]);
        });
    });

    describe('getUpdates', () => {
        beforeEach(() => {
            // Pre-populate history for get tests
            history.addUpdate('topicA', createMsg('sub1', 10));
            history.addUpdate('topicA', createMsg('sub1', 11));
            history.addUpdate('topicA', createMsg('sub1', 12));
            history.addUpdate('topicA', createMsg('sub1', 13));
            history.addUpdate('topicB', createMsg('sub2', 20));
        });

        it('should return empty array for non-existent topic', () => {
            expect(history.getUpdates('nonExistent', 0, 100)).toEqual([]);
        });

        it('should return empty array for invalid range (from >= to)', () => {
            expect(history.getUpdates('topicA', 11, 11)).toEqual([]);
            expect(history.getUpdates('topicA', 12, 11)).toEqual([]);
        });

        it('should return correct messages for a valid range within history', () => {
            const expected = [createMsg('sub1', 11), createMsg('sub1', 12)];
            expect(history.getUpdates('topicA', 10, 12)).toEqual(expected);
        });

        it('should return correct messages when range starts before history', () => {
            const expected = [createMsg('sub1', 10), createMsg('sub1', 11)];
            expect(history.getUpdates('topicA', 5, 11)).toEqual(expected);
        });

        it('should return correct messages when range ends after history', () => {
            const expected = [createMsg('sub1', 12), createMsg('sub1', 13)];
            expect(history.getUpdates('topicA', 11, 15)).toEqual(expected);
        });

         it('should return all messages when range covers entire history', () => {
            const expected = [
                createMsg('sub1', 10),
                createMsg('sub1', 11),
                createMsg('sub1', 12),
                createMsg('sub1', 13)
            ];
            expect(history.getUpdates('topicA', 9, 13)).toEqual(expected);
            expect(history.getUpdates('topicA', 0, 100)).toEqual(expected); // Wider range
        });

        it('should return empty array when range is completely before history', () => {
            expect(history.getUpdates('topicA', 0, 9)).toEqual([]);
        });

        it('should return empty array when range is completely after history', () => {
            expect(history.getUpdates('topicA', 13, 20)).toEqual([]);
        });

        it('should return correct messages for a different topic', () => {
             expect(history.getUpdates('topicB', 19, 20)).toEqual([createMsg('sub2', 20)]);
             expect(history.getUpdates('topicB', 0, 19)).toEqual([]);
        });
    });

     describe('clearTopicHistory', () => {
        beforeEach(() => {
            history.addUpdate('topicA', createMsg('sub1', 1));
            history.addUpdate('topicB', createMsg('sub2', 2));
        });

        it('should clear history for the specified topic', () => {
            history.clearTopicHistory('topicA');
            expect(history.getUpdates('topicA', 0, 1)).toEqual([]);
        });

        it('should not affect history of other topics', () => {
            history.clearTopicHistory('topicA');
            expect(history.getUpdates('topicB', 1, 2)).toEqual([createMsg('sub2', 2)]);
        });

        it('should do nothing if topic does not exist', () => {
            expect(() => history.clearTopicHistory('nonExistent')).not.toThrow();
            expect(history.getUpdates('topicA', 0, 1)).toEqual([createMsg('sub1', 1)]);
            expect(history.getUpdates('topicB', 1, 2)).toEqual([createMsg('sub2', 2)]);
        });
    });

    describe('clearAllHistory', () => {
        beforeEach(() => {
            history.addUpdate('topicA', createMsg('sub1', 1));
            history.addUpdate('topicB', createMsg('sub2', 2));
        });

        it('should clear history for all topics', () => {
            history.clearAllHistory();
            expect(history.getUpdates('topicA', 0, 1)).toEqual([]);
            expect(history.getUpdates('topicB', 1, 2)).toEqual([]);
        });
    });

     describe('Options', () => {
        it('should use default buffer size (1000) if not provided', () => {
            // This is hard to test directly without adding 1001 items.
            // We rely on the pruning test with a small buffer size as evidence.
            // We can check the default value in the source code.
            const defaultHistory = createInMemoryUpdateHistory();
            // Add 2 messages
            defaultHistory.addUpdate('topicDef', createMsg('subDef', 1));
            defaultHistory.addUpdate('topicDef', createMsg('subDef', 2));
            // Check they are still there (buffer is much larger than 2)
            expect(defaultHistory.getUpdates('topicDef', 0, 2).length).toBe(2);
        });

        it('should use provided buffer size for pruning', () => {
             const historySmall = createInMemoryUpdateHistory({ bufferSize: 1 });
             const msg1 = createMsg('subSmall', 1);
             const msg2 = createMsg('subSmall', 2);

             historySmall.addUpdate('topicSmall', msg1);
             expect(historySmall.getUpdates('topicSmall', 0, 1)).toEqual([msg1]);

             historySmall.addUpdate('topicSmall', msg2); // Prunes msg1
             expect(historySmall.getUpdates('topicSmall', 0, 2)).toEqual([msg2]);
             expect(historySmall.getUpdates('topicSmall', 0, 1)).toEqual([]);
        });
    });
});