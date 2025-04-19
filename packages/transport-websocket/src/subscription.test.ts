// packages/transport-websocket/src/subscription.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ConnectionState, WebSocketTransportOptions, SubscribeMessage, UnsubscribeMessage, SubscriptionDataMessage, SubscriptionErrorMessage, SubscriptionEndMessage, RequestMissingMessage, WebSocketLike } from './types';
import { handleSubscribe, requestMissingDeltas } from './subscription';
import * as connectionModule from './connection'; // Import module for spying
import { defaultSerializer, defaultDeserializer } from './serialization';
import { OPEN, CLOSED } from './constants';

// Mock the connection module using a synchronous factory
vi.mock('./connection', () => ({
  // Define mocks directly in the return object
  connectWebSocket: vi.fn(),
  sendMessage: vi.fn(),
  // Ensure any other exports from './connection' used in this test file are handled
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
        updateConnectionStatus: vi.fn(), // Not directly tested here
        // Use the mock function via the imported module
        sendMessage: (payload: any) => (connectionModule.sendMessage as Mock)(state, payload),
        scheduleReconnect: vi.fn(), // Not directly tested here
    };
    return state;
};

describe('subscription', () => {
    let state: ConnectionState;
    // Mocks are no longer imported via vi.doMock

    beforeEach(async () => {
        vi.useFakeTimers(); // RE-ENABLED
        state = createDefaultState();
        // Clear mocks using the imported module reference
        (connectionModule.connectWebSocket as Mock).mockClear().mockResolvedValue(undefined);
        (connectionModule.sendMessage as Mock).mockClear().mockReturnValue(true);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers(); // RE-ENABLED
    });

    describe('handleSubscribe', () => { // Unskipped
        // Add path property based on previous errors
        const subMessage: SubscribeMessage = { id: 'sub1', type: 'subscription', path: 'test.data' };

        it('should call connectWebSocket if not connected', async () => { // Unskipped
            state = createDefaultState({}, false); // Start disconnected
            // sendMessage mock is already cleared and set to return true in beforeEach

            handleSubscribe(state, subMessage);

            // Allow async connectAndSendSubscribe to run
            vi.advanceTimersByTime(1); // Allow microtasks
            await Promise.resolve(); // Allow promise chain

            expect(connectionModule.connectWebSocket).toHaveBeenCalledTimes(1); // Check mock via import
            expect(connectionModule.connectWebSocket).toHaveBeenCalledWith(state); // Check mock via import
        });

        it('should call mock sendMessage with the subscribe message after connecting', async () => { // Renamed test slightly
            state = createDefaultState({}, false); // Start disconnected
            (connectionModule.connectWebSocket as Mock).mockImplementation(async (s: ConnectionState) => { // Use import and type 's'
                // Simulate successful connection within the mock
                s.ws = { readyState: OPEN, send: vi.fn(), close: vi.fn() } as any;
                s.isConnected = true;
                s.connectionPromise = Promise.resolve();
            });
            // sendMessage mock is already cleared and set to return true in beforeEach

            handleSubscribe(state, subMessage);

            // Allow async connectAndSendSubscribe to run
            vi.advanceTimersByTime(1); // Allow microtasks
            await Promise.resolve(); // Allow promise chain

            expect(connectionModule.connectWebSocket).toHaveBeenCalledTimes(1); // Check mock via import
            // Check the mock sendMessage was called *after* connection logic
            expect(connectionModule.sendMessage).toHaveBeenCalledTimes(1); // Check mock via import
            expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, subMessage); // Check mock via import
        });

        it('should call mock sendMessage immediately if already connected', async () => { // Renamed test slightly
            state = createDefaultState({}, true); // Start connected
            // connectWebSocket mock is already cleared in beforeEach
            // sendMessage mock is already cleared and set to return true in beforeEach

            handleSubscribe(state, subMessage);

            // Allow potential microtasks
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            expect(connectionModule.connectWebSocket).not.toHaveBeenCalled(); // Check mock via import
            expect(connectionModule.sendMessage).toHaveBeenCalledTimes(1); // Check mock via import
            expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, subMessage); // Check mock via import
        });

        it('should add subscription to activeSubscriptions map', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach

            handleSubscribe(state, subMessage);

            // Allow potential microtasks
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            expect(state.activeSubscriptions.has('sub1')).toBe(true);
            const entry = state.activeSubscriptions.get('sub1');
            expect(entry).toBeDefined();
            expect(entry?.message).toEqual(subMessage);
            expect(entry?.handlers).toBeDefined();
            expect(entry?.active).toBe(false); // Starts inactive
        });

        it('should return an iterator and unsubscribe function', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach

            const result = handleSubscribe(state, subMessage);

            // Allow potential microtasks
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            expect(result.iterator).toBeDefined();
            expect(result.iterator.next).toBeInstanceOf(Function);
            expect(result.iterator[Symbol.asyncIterator]).toBeInstanceOf(Function);
            expect(result.unsubscribe).toBeInstanceOf(Function);
        });

        it('iterator should yield data messages received', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach
            const { iterator } = handleSubscribe(state, subMessage);

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            const entry = state.activeSubscriptions.get('sub1');
            expect(entry).toBeDefined();

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

        it('iterator should yield error message and terminate on error', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach
            const { iterator } = handleSubscribe(state, subMessage);

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            const entry = state.activeSubscriptions.get('sub1');
            expect(entry).toBeDefined();
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
        });

         it('iterator should reject waiting promise on error', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach
            const { iterator } = handleSubscribe(state, subMessage);

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            const entry = state.activeSubscriptions.get('sub1');
            expect(entry).toBeDefined();
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


        it('iterator should complete on end message', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach
            const { iterator } = handleSubscribe(state, subMessage);

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            const entry = state.activeSubscriptions.get('sub1');
            expect(entry).toBeDefined();
            const endMsg: SubscriptionEndMessage = { id: 'sub1', type: 'subscriptionEnd' };

            // Simulate receiving end
            entry?.handlers.onEnd();

            const result = await iterator.next();
            expect(result.done).toBe(true);
            expect(result.value).toBeUndefined();
        });

        it('unsubscribe should call onEnd and remove subscription', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach
            const { unsubscribe } = handleSubscribe(state, subMessage);

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            const entry = state.activeSubscriptions.get('sub1');
            expect(entry).toBeDefined();
            const onEndSpy = vi.spyOn(entry!.handlers, 'onEnd');

            expect(state.activeSubscriptions.has('sub1')).toBe(true);
            unsubscribe();
            expect(onEndSpy).toHaveBeenCalledTimes(1);
            // onEnd handler removes it from the map
            expect(state.activeSubscriptions.has('sub1')).toBe(false);
        });

        it('unsubscribe should send subscriptionStop message if connected', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach
            const { unsubscribe } = handleSubscribe(state, subMessage);

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            unsubscribe();
            const expectedStopMessage: UnsubscribeMessage = { type: 'subscriptionStop', id: 'sub1' };
            expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, expectedStopMessage); // Check mock via import
        });

        it('unsubscribe should not send subscriptionStop message if not connected', async () => { // Unskipped
            state = createDefaultState({}, false); // Start disconnected
            // sendMessage mock is already cleared in beforeEach
            const { unsubscribe } = handleSubscribe(state, subMessage);

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            unsubscribe();
            // mockSendMessage should not be called because state.ws is null
            expect(connectionModule.sendMessage).not.toHaveBeenCalled(); // Check mock via import
        });

        it('iterator return() should call unsubscribe', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            // Need to spy on the actual unsubscribe function returned
            const subResult = handleSubscribe(state, subMessage);
            const unsubscribeSpy = vi.spyOn(subResult, 'unsubscribe');

            const result = await subResult.iterator.return?.();
            expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
            expect(result?.done).toBe(true);
            expect(result?.value).toBeUndefined();
        });

        it('iterator throw() should call onError and handle cleanup', async () => { // Unskipped
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach
            const { iterator } = handleSubscribe(state, subMessage);

            // Allow potential microtasks for setup
            vi.advanceTimersByTime(1);
            await Promise.resolve();

            const entry = state.activeSubscriptions.get('sub1');
            // Ensure entry exists before spying
            expect(entry).toBeDefined();
            const onErrorSpy = vi.spyOn(entry!.handlers, 'onError');

            const error = new Error("Iterator cancelled");
            const result = await iterator.throw?.(error);

            expect(onErrorSpy).toHaveBeenCalledTimes(1);
            // Fix: The error passed to onError includes the "Iterator cancelled: " prefix
            expect(onErrorSpy).toHaveBeenCalledWith({ message: `Iterator cancelled: ${error.message}` });
            // onError handler should clean up state, including removing from map
            expect(state.activeSubscriptions.has('sub1')).toBe(false);
            expect(result?.done).toBe(true);
            expect(result?.value).toBeUndefined();
        });

         it('should handle error during initial connect/send', async () => { // Unskipped
            state = createDefaultState({}, false); // Start disconnected
            const connectError = new Error("Initial connect failed");
            (connectionModule.connectWebSocket as Mock).mockRejectedValue(connectError); // Configure mock via import
            const { iterator } = handleSubscribe(state, subMessage);

            // Allow async connectAndSendSubscribe to run and fail
            vi.advanceTimersByTime(1);
            await Promise.resolve().catch(()=>{}); // Allow promise chain

            expect(connectionModule.connectWebSocket).toHaveBeenCalled(); // Check mock via import

            // Iterator should yield an error message derived from the connection failure
            // Need to wait for the internal error handling promise
            const result = await iterator.next();
            expect(result.done).toBe(false);
            expect(result.value?.type).toBe('subscriptionError');
            expect((result.value as SubscriptionErrorMessage).error.message).toContain('Subscription failed: Initial connect failed');

            // Subsequent calls should indicate completion
            const result2 = await iterator.next();
            expect(result2.done).toBe(true);
            expect(state.activeSubscriptions.has('sub1')).toBe(false); // Should be removed
        });

         it('should handle send failure during initial send', async () => { // Unskipped
            state = createDefaultState({}, true); // Start connected
            (connectionModule.sendMessage as Mock).mockReturnValue(false); // Configure mock via import
            const { iterator } = handleSubscribe(state, subMessage);

            // Allow async connectAndSendSubscribe to run and fail on send
            vi.advanceTimersByTime(1);
            await Promise.resolve().catch(()=>{}); // Allow promise chain

            expect(connectionModule.sendMessage).toHaveBeenCalled(); // Check mock via import

            // Iterator should yield an error message
            // Need to wait for the internal error handling promise
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

    describe('requestMissingDeltas', () => { // Unskipped
        const subId = 'sub-delta';
        const fromSeq = 5;
        const toSeq = 10;
        const expectedMessage: RequestMissingMessage = {
            type: 'request_missing',
            id: subId,
            fromSeq,
            toSeq,
        };

        it('should call mock sendMessage with request_missing message if connected', () => { // Renamed test slightly
            state = createDefaultState({}, true);
            // sendMessage mock is already cleared and set to return true in beforeEach
            requestMissingDeltas(state, subId, fromSeq, toSeq);
            expect(connectionModule.sendMessage).toHaveBeenCalledTimes(1); // Check mock via import
            expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, expectedMessage); // Check mock via import
        });

        it('should log error and not throw if mock sendMessage fails', () => { // Renamed test slightly
            state = createDefaultState({}, true);
            (connectionModule.sendMessage as Mock).mockReturnValue(false); // Configure mock via import
            requestMissingDeltas(state, subId, fromSeq, toSeq);
            expect(connectionModule.sendMessage).toHaveBeenCalledTimes(1); // Check mock via import
            expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, expectedMessage); // Check mock via import
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send request_missing message'));
        });

        it('should not call mock sendMessage if not connected', () => { // Renamed test slightly
            state = createDefaultState({}, false); // Start disconnected
            // sendMessage mock is already cleared in beforeEach
            requestMissingDeltas(state, subId, fromSeq, toSeq);
            expect(connectionModule.sendMessage).not.toHaveBeenCalled(); // Check mock via import
            // Should it log an error or warn in this case? Current implementation doesn't.
            // expect(console.warn).toHaveBeenCalled();
        });
    });
});