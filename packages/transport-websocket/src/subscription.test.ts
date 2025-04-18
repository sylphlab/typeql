// packages/transport-websocket/src/subscription.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ConnectionState, WebSocketTransportOptions, SubscribeMessage, UnsubscribeMessage, SubscriptionDataMessage, SubscriptionErrorMessage, SubscriptionEndMessage, RequestMissingMessage, WebSocketLike } from './types';
import { handleSubscribe, requestMissingDeltas } from './subscription';
import { connectWebSocket, sendMessage } from './connection'; // Mock these
import { defaultSerializer, defaultDeserializer } from './serialization';
import { OPEN, CLOSED } from './constants';

// Mock dependencies from './connection'
vi.doMock('./connection', () => ({
    connectWebSocket: vi.fn(),
    sendMessage: vi.fn(),
    updateConnectionStatus: vi.fn(),
    scheduleReconnect: vi.fn(),
    disconnectWebSocket: vi.fn(),
}));

// Helper to create default state
const createDefaultState = (options: Partial<WebSocketTransportOptions> = {}, connected = true): ConnectionState => {
    const opts: WebSocketTransportOptions = {
        url: 'ws://subscription-test.com',
        ...options,
    };
    const mockWs: WebSocketLike | null = connected ? {
        readyState: OPEN,
        send: vi.fn(),
        close: vi.fn(),
        onopen: null, onerror: null, onclose: null, onmessage: null,
    } : null;

    const state: ConnectionState = {
        ws: mockWs,
        isConnected: connected,
        connectionPromise: connected ? Promise.resolve() : null,
        reconnectAttempts: 0,
        reconnectTimeoutId: undefined,
        options: opts,
        WebSocketImplementation: vi.fn() as any,
        serializer: opts.serializer ?? defaultSerializer,
        deserializer: opts.deserializer ?? defaultDeserializer,
        pendingRequests: new Map(),
        activeSubscriptions: new Map(),
        connectionChangeListeners: new Set(),
        disconnectListeners: new Set(),
        updateConnectionStatus: vi.fn(),
        sendMessage: (payload: any) => (sendMessage as Mock)(state, payload),
        scheduleReconnect: vi.fn(),
    };
    return state;
};

describe('subscription', () => {
    let state: ConnectionState;
    let mockConnectWebSocket: Mock;
    let mockSendMessage: Mock;

    beforeEach(async () => {
        // Dynamically import mocked functions after mocks are set up
        const connectionMock = await import('./connection');
        mockConnectWebSocket = connectionMock.connectWebSocket as Mock;
        mockSendMessage = connectionMock.sendMessage as Mock;

        vi.useFakeTimers();
        mockConnectWebSocket.mockClear().mockResolvedValue(undefined); // Default mock successful connection
        mockSendMessage.mockClear().mockReturnValue(true); // Default mock successful send
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.resetModules();
    });

    describe('handleSubscribe', () => {
        // Add path property based on previous errors
        const subMessage: SubscribeMessage = { id: 'sub1', type: 'subscription', path: 'test.data' };

        it('should call connectWebSocket if not connected', async () => {
            state = createDefaultState({}, false); // Start disconnected
            handleSubscribe(state, subMessage);
            // Allow async connectAndSendSubscribe to run
            await vi.advanceTimersByTimeAsync(1);
            expect(mockConnectWebSocket).toHaveBeenCalledTimes(1);
            expect(mockConnectWebSocket).toHaveBeenCalledWith(state);
        });

        it('should call sendMessage with the subscribe message after connecting', async () => {
            state = createDefaultState({}, false);
            handleSubscribe(state, subMessage);
            await vi.advanceTimersByTimeAsync(1); // Allow connectAndSendSubscribe
            expect(mockConnectWebSocket).toHaveBeenCalledTimes(1);
            // Simulate connection success needed for sendMessage to be called
            state.ws = { readyState: OPEN } as any;
            state.isConnected = true;
            // Rerun timers to allow the async function to proceed after await
            await vi.advanceTimersByTimeAsync(1);
            expect(mockSendMessage).toHaveBeenCalledTimes(1);
            expect(mockSendMessage).toHaveBeenCalledWith(state, subMessage);
        });

        it('should call sendMessage immediately if already connected', () => {
            state = createDefaultState({}, true);
            handleSubscribe(state, subMessage);
            // Should be called synchronously in this case because connectAndSendSubscribe is async but doesn't await if already connected
            // Need to advance timers slightly to allow the async function to execute its synchronous part
            vi.advanceTimersByTime(1);
            expect(mockConnectWebSocket).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledTimes(1);
            expect(mockSendMessage).toHaveBeenCalledWith(state, subMessage);
        });

        it('should add subscription to activeSubscriptions map', () => {
            state = createDefaultState({}, true);
            handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async function's sync part
            expect(state.activeSubscriptions.has('sub1')).toBe(true);
            const entry = state.activeSubscriptions.get('sub1');
            expect(entry).toBeDefined();
            expect(entry?.message).toEqual(subMessage);
            expect(entry?.handlers).toBeDefined();
            expect(entry?.active).toBe(false); // Starts inactive
        });

        it('should return an iterator and unsubscribe function', () => {
            state = createDefaultState({}, true);
            const result = handleSubscribe(state, subMessage);
            expect(result.iterator).toBeDefined();
            expect(result.iterator.next).toBeInstanceOf(Function);
            expect(result.iterator[Symbol.asyncIterator]).toBeInstanceOf(Function);
            expect(result.unsubscribe).toBeInstanceOf(Function);
        });

        it('iterator should yield data messages received', async () => {
            state = createDefaultState({}, true);
            const { iterator } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            const entry = state.activeSubscriptions.get('sub1');
            // Add serverSeq based on previous errors
            const dataMsg: SubscriptionDataMessage = { id: 'sub1', type: 'subscriptionData', serverSeq: 1, data: { value: 'A' } };

            // Simulate receiving data
            entry?.handlers.onData(dataMsg);

            const result = await iterator.next();
            expect(result.done).toBe(false);
            expect(result.value).toEqual(dataMsg);

            // Check queueing
            const dataMsg2: SubscriptionDataMessage = { id: 'sub1', type: 'subscriptionData', serverSeq: 2, data: { value: 'B' } };
            entry?.handlers.onData(dataMsg2); // Received while not waiting

            const result2 = await iterator.next(); // Pull from queue
            expect(result2.done).toBe(false);
            expect(result2.value).toEqual(dataMsg2);
        });

        it('iterator should yield error message and terminate on error', async () => {
            state = createDefaultState({}, true);
            const { iterator } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            const entry = state.activeSubscriptions.get('sub1');
            const errorDetail = { message: 'Subscription failed on server' };
            const errorMsg: SubscriptionErrorMessage = { id: 'sub1', type: 'subscriptionError', error: errorDetail };

            // Simulate receiving error
            entry?.handlers.onError(errorDetail);

            // Iterator should yield the error message once
            const result = await iterator.next();
            expect(result.done).toBe(false);
            expect(result.value).toEqual(errorMsg);

            // Subsequent calls should indicate completion
            const result2 = await iterator.next();
            expect(result2.done).toBe(true);
            expect(result2.value).toBeUndefined();
            expect(state.activeSubscriptions.has('sub1')).toBe(false); // Should be removed
        });

         it('iterator should reject waiting promise on error', async () => {
            state = createDefaultState({}, true);
            const { iterator } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            const entry = state.activeSubscriptions.get('sub1');
            const errorDetail = { message: 'Subscription failed while waiting' };

            // Start waiting for the next value
            const nextPromise = iterator.next();

            // Simulate receiving error while waiting
            entry?.handlers.onError(errorDetail);

            // The waiting promise should reject
            await expect(nextPromise).rejects.toThrow('Subscription failed while waiting');

            // Subsequent calls should indicate completion
            const result2 = await iterator.next();
            expect(result2.done).toBe(true);
            expect(result2.value).toBeUndefined();
            expect(state.activeSubscriptions.has('sub1')).toBe(false); // Should be removed
        });


        it('iterator should complete on end message', async () => {
            state = createDefaultState({}, true);
            const { iterator } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            const entry = state.activeSubscriptions.get('sub1');
            const endMsg: SubscriptionEndMessage = { id: 'sub1', type: 'subscriptionEnd' };

            // Simulate receiving end
            entry?.handlers.onEnd();

            const result = await iterator.next();
            expect(result.done).toBe(true);
            expect(result.value).toBeUndefined();
            expect(state.activeSubscriptions.has('sub1')).toBe(false); // Should be removed
        });

        it('unsubscribe should call onEnd and remove subscription', () => {
            state = createDefaultState({}, true);
            const { unsubscribe } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            const entry = state.activeSubscriptions.get('sub1');
            const onEndSpy = vi.spyOn(entry!.handlers, 'onEnd');

            expect(state.activeSubscriptions.has('sub1')).toBe(true);
            unsubscribe();
            expect(onEndSpy).toHaveBeenCalledTimes(1);
            // onEnd handler removes it from the map
            expect(state.activeSubscriptions.has('sub1')).toBe(false);
        });

        it('unsubscribe should send subscriptionStop message if connected', () => {
            state = createDefaultState({}, true);
            const { unsubscribe } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            unsubscribe();
            const expectedStopMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: 'sub1' };
            expect(mockSendMessage).toHaveBeenCalledWith(state, expectedStopMessage);
        });

        it('unsubscribe should not send subscriptionStop message if not connected', () => {
            state = createDefaultState({}, false); // Start disconnected
            const { unsubscribe } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            unsubscribe();
            const expectedStopMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: 'sub1' };
            expect(mockSendMessage).not.toHaveBeenCalledWith(state, expectedStopMessage);
        });

        it('iterator return() should call unsubscribe', async () => {
            state = createDefaultState({}, true);
            const { iterator } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            // Need to spy on the actual unsubscribe function returned
            const subResult = handleSubscribe(state, subMessage);
            const unsubscribeSpy = vi.spyOn(subResult, 'unsubscribe');

            const result = await subResult.iterator.return?.();
            expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
            expect(result?.done).toBe(true);
            expect(result?.value).toBeUndefined();
        });

        it('iterator throw() should call onError and handle cleanup', async () => {
            state = createDefaultState({}, true);
            const { iterator } = handleSubscribe(state, subMessage);
            vi.advanceTimersByTime(1); // Allow async setup
            const entry = state.activeSubscriptions.get('sub1');
            // Ensure entry exists before spying
            expect(entry).toBeDefined();
            const onErrorSpy = vi.spyOn(entry!.handlers, 'onError');

            const error = new Error("Iterator cancelled");
            const result = await iterator.throw?.(error);

            expect(onErrorSpy).toHaveBeenCalledTimes(1);
            expect(onErrorSpy).toHaveBeenCalledWith({ message: `Iterator cancelled: ${error.message}` });
            // onError handler should clean up state, including removing from map
            expect(state.activeSubscriptions.has('sub1')).toBe(false);

            expect(result?.done).toBe(true);
            expect(result?.value).toBeUndefined();
        });

         it('should handle error during initial connect/send', async () => {
            state = createDefaultState({}, false); // Start disconnected
            const connectError = new Error("Initial connect failed");
            mockConnectWebSocket.mockRejectedValue(connectError); // Mock connection failure

            const { iterator } = handleSubscribe(state, subMessage);

            // Allow async connectAndSendSubscribe to run and fail
            await vi.advanceTimersByTimeAsync(1);

            // Iterator should yield an error message derived from the connection failure
            const result = await iterator.next();
            expect(result.done).toBe(false);
            expect(result.value?.type).toBe('subscriptionError');
            expect((result.value as SubscriptionErrorMessage).error.message).toContain('Subscription failed: Initial connect failed');

            // Subsequent calls should indicate completion
            const result2 = await iterator.next();
            expect(result2.done).toBe(true);
            expect(state.activeSubscriptions.has('sub1')).toBe(false); // Should be removed
        });

         it('should handle send failure during initial send', async () => {
            state = createDefaultState({}, true); // Start connected
            mockSendMessage.mockReturnValue(false); // Mock send failure

            const { iterator } = handleSubscribe(state, subMessage);

            // Allow async connectAndSendSubscribe to run and fail on send
            await vi.advanceTimersByTimeAsync(1);

            // Iterator should yield an error message
            const result = await iterator.next();
            expect(result.done).toBe(false);
            expect(result.value?.type).toBe('subscriptionError');
            expect((result.value as SubscriptionErrorMessage).error.message).toContain('Subscription failed: Failed to send subscribe message');

            // Subsequent calls should indicate completion
            const result2 = await iterator.next();
            expect(result2.done).toBe(true);
            expect(state.activeSubscriptions.has('sub1')).toBe(false); // Should be removed
        });

    });

    describe('requestMissingDeltas', () => {
        const subId = 'sub-delta';
        const fromSeq = 5;
        const toSeq = 10;
        const expectedMessage: RequestMissingMessage = {
            type: 'request_missing',
            id: subId,
            fromSeq,
            toSeq,
        };

        it('should call sendMessage with request_missing message if connected', () => {
            state = createDefaultState({}, true);
            requestMissingDeltas(state, subId, fromSeq, toSeq);
            expect(mockSendMessage).toHaveBeenCalledTimes(1);
            expect(mockSendMessage).toHaveBeenCalledWith(state, expectedMessage);
        });

        it('should log error and not throw if sendMessage fails', () => {
            state = createDefaultState({}, true);
            mockSendMessage.mockReturnValue(false); // Simulate send failure
            requestMissingDeltas(state, subId, fromSeq, toSeq);
            expect(mockSendMessage).toHaveBeenCalledTimes(1);
            expect(mockSendMessage).toHaveBeenCalledWith(state, expectedMessage);
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send request_missing message'));
        });

        it('should not call sendMessage if not connected', () => {
            state = createDefaultState({}, false); // Start disconnected
            requestMissingDeltas(state, subId, fromSeq, toSeq);
            expect(mockSendMessage).not.toHaveBeenCalled();
            // Should it log an error or warn in this case? Current implementation doesn't.
            // expect(console.warn).toHaveBeenCalled();
        });
    });
});