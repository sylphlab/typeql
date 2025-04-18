// packages/transport-websocket/src/connection.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ConnectionState, WebSocketLike, WebSocketTransportOptions, PendingRequestEntry, ActiveSubscriptionEntry, InternalSubscriptionHandlers, ProcedureResultMessage, AckMessage, SubscribeMessage, SubscriptionDataMessage, SubscriptionErrorMessage, SubscriptionEndMessage } from './types'; // Added missing types
import { updateConnectionStatus, sendMessage, scheduleReconnect, connectWebSocket, disconnectWebSocket } from './connection';
import { defaultSerializer, defaultDeserializer } from './serialization';
import { CONNECTING, OPEN, CLOSING, CLOSED, CLOSE_CODE_NORMAL, CLOSE_CODE_GOING_AWAY, DEFAULT_MAX_RECONNECT_ATTEMPTS, DEFAULT_BASE_RECONNECT_DELAY_MS, MAX_RECONNECT_DELAY_MS, RECONNECT_JITTER_FACTOR_MIN, RECONNECT_JITTER_FACTOR_MAX } from './constants'; // Added missing constants

// --- Mock WebSocket Implementation ---
class MockWebSocket implements WebSocketLike {
    // Make readyState public for test manipulation
    public readyState: number = CONNECTING;
    url: string;
    sentData: any[] = [];
    // Add static properties to match WebSocket interface
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    closeCode?: number;
    closeReason?: string;

    onopen: (() => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        // Simulate async connection
        // setTimeout(() => this._simulateOpen(), 10); // Don't auto-open, control in tests
    }

    send = vi.fn((data: string | Buffer | ArrayBuffer | Buffer[]) => {
        if (this.readyState !== OPEN) throw new Error('WebSocket not open');
        this.sentData.push(data);
    });

    close = vi.fn((code?: number, reason?: string) => {
        if (this.readyState === CLOSING || this.readyState === CLOSED) return;
        this.readyState = CLOSING;
        this.closeCode = code;
        this.closeReason = reason;
        // Simulate async close
        setTimeout(() => this._simulateClose(code, reason), 5);
    });

    // --- Simulation methods ---
    _simulateOpen() {
        if (this.readyState === CONNECTING) {
            this.readyState = OPEN;
            this.onopen?.();
        }
    }

    _simulateError(error: any) {
        if (this.readyState !== CLOSED) {
            // this.readyState = CLOSED; // Error might not always immediately close
            this.onerror?.({ type: 'error', message: error?.message || 'Simulated error', error }); // Pass original error
            // Simulate potential subsequent close
            // setTimeout(() => this._simulateClose(1006, 'Simulated error close'), 5);
        }
    }

    _simulateClose(code = CLOSE_CODE_NORMAL, reason = 'Simulated close') {
        if (this.readyState !== CLOSED) {
            const wasConnected = this.readyState === OPEN;
            this.readyState = CLOSED;
            // Only call onclose if it was previously connecting or open
            if (wasConnected || this.readyState === CONNECTING) {
                 this.onclose?.({ code, reason });
            }
        }
    }

    _simulateMessage(data: any) {
        if (this.readyState === OPEN) {
            this.onmessage?.({ data });
        }
    }
}

// Helper to create default state
const createDefaultState = (options: Partial<WebSocketTransportOptions> = {}): ConnectionState => {
    const opts: WebSocketTransportOptions = {
        url: 'ws://test.com',
        WebSocket: MockWebSocket as any, // Cast to any for test mock compatibility
        ...options,
    };
    // Cannot assign `state` here as it's not defined yet.
    // We'll create a temporary object and then assign the methods.
    const tempState: Omit<ConnectionState, 'updateConnectionStatus' | 'sendMessage' | 'scheduleReconnect'> = {
        ws: null,
        isConnected: false,
        connectionPromise: null,
        reconnectAttempts: 0,
        reconnectTimeoutId: undefined,
        options: opts,
        WebSocketImplementation: (opts.WebSocket || MockWebSocket) as any, // Cast to any
        serializer: opts.serializer ?? defaultSerializer,
        deserializer: opts.deserializer ?? defaultDeserializer,
        pendingRequests: new Map<string | number, PendingRequestEntry>(),
        activeSubscriptions: new Map<string | number, ActiveSubscriptionEntry>(),
        connectionChangeListeners: new Set<(connected: boolean) => void>(),
        disconnectListeners: new Set<() => void>(),
    };

    // Now create the final state with methods bound correctly
    const finalState = tempState as ConnectionState;
    finalState.updateConnectionStatus = (newStatus: boolean) => updateConnectionStatus(finalState, newStatus);
    finalState.sendMessage = (payload: any) => sendMessage(finalState, payload);
    finalState.scheduleReconnect = (isImmediate?: boolean) => scheduleReconnect(finalState, isImmediate);

    return finalState;
};

let state: ConnectionState;

describe('connection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        state = createDefaultState();
        // Spies setup
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'debug').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('updateConnectionStatus', () => {
        it('should update isConnected state', () => {
            expect(state.isConnected).toBe(false);
            updateConnectionStatus(state, true);
            expect(state.isConnected).toBe(true);
            updateConnectionStatus(state, false);
            expect(state.isConnected).toBe(false);
        });

        it('should call connectionChangeListeners only when status changes', () => {
            const listener = vi.fn();
            state.connectionChangeListeners.add(listener);

            updateConnectionStatus(state, true); // false -> true
            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith(true);

            updateConnectionStatus(state, true); // true -> true (no change)
            expect(listener).toHaveBeenCalledTimes(1);

            updateConnectionStatus(state, false); // true -> false
            expect(listener).toHaveBeenCalledTimes(2);
            expect(listener).toHaveBeenCalledWith(false);
        });
    });

    describe('sendMessage', () => {
        beforeEach(async () => {
            // Ensure connected state for most tests
            connectWebSocket(state); // Don't await here, simulate open manually
            vi.advanceTimersByTime(1); // Allow microtasks
            (state.ws as MockWebSocket)._simulateOpen();
            vi.advanceTimersByTime(1); // Allow open handler
            expect(state.isConnected).toBe(true);
            expect(state.ws).toBeInstanceOf(MockWebSocket);
            // Clear mocks from connection phase
            vi.clearAllMocks();
             // Re-setup spies after clearing
            vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            vi.spyOn(console, 'error').mockImplementation(() => {});
            vi.spyOn(console, 'debug').mockImplementation(() => {});
        });

        it('should send serialized message when connected', () => {
            const payload = { id: 1, type: 'query', procedure: 'test' };
            const result = sendMessage(state, payload);
            expect(result).toBe(true);
            expect((state.ws as MockWebSocket).send).toHaveBeenCalledTimes(1);
            expect((state.ws as MockWebSocket).send).toHaveBeenCalledWith(JSON.stringify(payload));
        });

        it('should return false and not send if WebSocket is not open', () => {
            (state.ws! as MockWebSocket).readyState = CLOSED; // Simulate closed state (cast needed)
            const payload = { id: 2, type: 'mutation' };
            const sendSpy = vi.spyOn(state.ws!, 'send'); // Spy on the instance method
            const result = sendMessage(state, payload);
            expect(result).toBe(false);
            expect(sendSpy).not.toHaveBeenCalled();
        });

        it('should return false and log error if serialization fails', () => {
            const badPayload = { id: 3, type: 'bad', data: BigInt(123) }; // BigInt cannot be serialized by default
            const serializerSpy = vi.spyOn(state, 'serializer').mockImplementationOnce(() => { throw new Error('Serialization failed'); });
            const sendSpy = vi.spyOn(state.ws!, 'send');
            const result = sendMessage(state, badPayload);
            expect(result).toBe(false);
            expect(serializerSpy).toHaveBeenCalledWith(badPayload);
            expect(sendSpy).not.toHaveBeenCalled(); // Ensure send wasn't called
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to serialize'), expect.any(Error), badPayload);
        });

        it('should warn if message has no ID', () => {
             const payload = { type: 'notify' }; // No ID
             sendMessage(state, payload);
             expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Message sent without ID'), payload);
             expect((state.ws as MockWebSocket).send).toHaveBeenCalled(); // Should still send
        });
    });

    describe('scheduleReconnect', () => {
        it('should schedule reconnect with exponential backoff', () => {
            scheduleReconnect(state); // Attempt 1
            expect(state.reconnectAttempts).toBe(1);
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
            // Delay should be around base delay * 2^0 * jitter
            const delay1 = setTimeoutSpy.mock.calls[0]?.[1]; // Safe access
            expect(delay1).toBeGreaterThanOrEqual(DEFAULT_BASE_RECONNECT_DELAY_MS * RECONNECT_JITTER_FACTOR_MIN);
            expect(delay1).toBeLessThanOrEqual(DEFAULT_BASE_RECONNECT_DELAY_MS * RECONNECT_JITTER_FACTOR_MAX);
            setTimeoutSpy.mockRestore(); // Restore original setTimeout

            vi.clearAllTimers(); // Clear timers set by the function under test
            const setTimeoutSpy2 = vi.spyOn(global, 'setTimeout'); // Re-spy for next check
            scheduleReconnect(state); // Attempt 2
            expect(state.reconnectAttempts).toBe(2);
            expect(setTimeoutSpy2).toHaveBeenCalledTimes(1);
            // Delay should be around base delay * 2^1 * jitter
            const delay2 = setTimeoutSpy2.mock.calls[0]?.[1]; // Safe access
            expect(delay2).toBeGreaterThanOrEqual(DEFAULT_BASE_RECONNECT_DELAY_MS * 2 * RECONNECT_JITTER_FACTOR_MIN);
            expect(delay2).toBeLessThanOrEqual(DEFAULT_BASE_RECONNECT_DELAY_MS * 2 * RECONNECT_JITTER_FACTOR_MAX);
            setTimeoutSpy2.mockRestore();
        });

        it('should schedule immediate reconnect if isImmediate is true', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            scheduleReconnect(state, true);
            expect(state.reconnectAttempts).toBe(1);
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
            expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(0); // Immediate
            setTimeoutSpy.mockRestore();
        });

        it('should clear existing timer before scheduling new one', () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
            state.reconnectTimeoutId = setTimeout(() => {}, 1000); // Set a dummy timer ID
            const timerId = state.reconnectTimeoutId;
            expect(clearTimeoutSpy).not.toHaveBeenCalled();
            scheduleReconnect(state);
            expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
            clearTimeoutSpy.mockRestore();
        });

        it('should not schedule if max attempts reached', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            state.reconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS;
            scheduleReconnect(state);
            expect(setTimeoutSpy).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Max reconnect attempts'));
            setTimeoutSpy.mockRestore();
        });

        it('should call connectWebSocket when timer fires', () => {
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            // Mock connectWebSocket to prevent actual execution and check call
            const connectWebSocketInternal = vi.fn().mockResolvedValue(undefined);
            // Need a way to inject this mock. Temporarily modify state for test.
            const originalConnect = connectWebSocket; // Store original
            (connectWebSocket as any) = connectWebSocketInternal; // Replace import

            scheduleReconnect(state);
            expect(connectWebSocketInternal).not.toHaveBeenCalled();
            vi.advanceTimersToNextTimer(); // Fire the timer

            expect(connectWebSocketInternal).toHaveBeenCalledTimes(1);
            expect(connectWebSocketInternal).toHaveBeenCalledWith(state, true); // Called as reconnect

            // Restore original function
             (connectWebSocket as any) = originalConnect;
        });
    });

    describe('connectWebSocket', () => {
        it('should instantiate WebSocket and set handlers', () => {
            connectWebSocket(state);
            expect(state.ws).toBeInstanceOf(MockWebSocket);
            expect(state.ws?.onopen).toBeInstanceOf(Function);
            expect(state.ws?.onerror).toBeInstanceOf(Function);
            expect(state.ws?.onclose).toBeInstanceOf(Function);
            expect(state.ws?.onmessage).toBeInstanceOf(Function);
        });

        it('should resolve promise on successful connection', async () => {
            const promise = connectWebSocket(state);
            expect(state.ws?.readyState).toBe(CONNECTING);
            (state.ws as MockWebSocket)._simulateOpen(); // Simulate connection open
            vi.advanceTimersByTime(1); // Allow handlers to run
            await expect(promise).resolves.toBeUndefined();
            expect(state.isConnected).toBe(true);
            expect(state.reconnectAttempts).toBe(0); // Reset on success
        });

        it('should reject promise on connection error', async () => {
            const promise = connectWebSocket(state);
            const mockError = new Error('Connection failed');
            (state.ws as MockWebSocket)._simulateError(mockError); // Simulate error
            vi.advanceTimersByTime(1); // Process error handler
            await expect(promise).rejects.toThrow('WebSocket error: Connection failed');
            expect(state.isConnected).toBe(false);
            // ws might not be null immediately after error, depends on subsequent close
            // expect(state.ws).toBeNull();
            // Check if reconnect is scheduled
            expect(setTimeout).toHaveBeenCalled();
        });

         it('should reject promise on connection close before open', async () => {
            const promise = connectWebSocket(state);
            (state.ws as MockWebSocket)._simulateClose(1006, 'Failed'); // Simulate close before open
            vi.advanceTimersByTime(1); // Process close handler
            await expect(promise).rejects.toThrow('WebSocket closed (Code: 1006, Reason: Failed)');
            expect(state.isConnected).toBe(false);
            expect(state.ws).toBeNull(); // Should be cleaned up by close handler
             // Check if reconnect is scheduled (non-1000 code)
             expect(setTimeout).toHaveBeenCalled();
        });

        it('should clean up previous instance before reconnecting', async () => {
            // First connection
            connectWebSocket(state);
            (state.ws as MockWebSocket)._simulateOpen();
            vi.advanceTimersByTime(1);
            const ws1 = state.ws as MockWebSocket;
            expect(state.isConnected).toBe(true);
            const closeSpy1 = vi.spyOn(ws1, 'close');

            // Simulate disconnect and trigger reconnect
            ws1._simulateClose(1006, 'Simulated disconnect');
            vi.advanceTimersByTime(1); // Process close handler (schedules reconnect)
            expect(state.isConnected).toBe(false);
            expect(setTimeout).toHaveBeenCalledTimes(1);

            vi.advanceTimersToNextTimer(); // Process reconnect timer (calls connectWebSocket again)

            // Check cleanup of ws1
            expect(closeSpy1).toHaveBeenCalledWith(CLOSE_CODE_GOING_AWAY, expect.any(String));
            // Handlers should be nulled by connectWebSocket before creating new instance
            // We can't easily check the old instance's handlers after it's replaced.
            // Instead, check that a *new* instance is created.

            // Check new connection
            expect(state.ws).toBeInstanceOf(MockWebSocket);
            expect(state.ws).not.toBe(ws1); // Ensure it's a new instance
            (state.ws as MockWebSocket)._simulateOpen(); // Allow new connection to open
            vi.advanceTimersByTime(1);
            await state.connectionPromise; // Wait for potential promise
            expect(state.isConnected).toBe(true);
        });

        it('should resubscribe inactive subscriptions on reconnect', async () => {
            // Initial connection
            connectWebSocket(state);
            (state.ws as MockWebSocket)._simulateOpen();
            vi.advanceTimersByTime(1);
            const ws1 = state.ws as MockWebSocket;
            const ws1SendSpy = vi.spyOn(ws1, 'send');

            // Add an inactive subscription
            // Add missing 'path' property
            const subMsg: SubscribeMessage = { id: 'sub1', type: 'subscription', path: 'test/path' };
            const subEntry: ActiveSubscriptionEntry = {
                message: subMsg,
                handlers: { onData: vi.fn(), onError: vi.fn(), onEnd: vi.fn(), onStart: vi.fn() },
                active: false // Mark as inactive
            };
            state.activeSubscriptions.set('sub1', subEntry);

            // Simulate disconnect and reconnect
            ws1._simulateClose(1006);
            vi.advanceTimersByTime(1); // Process close
            vi.advanceTimersToNextTimer(); // Process reconnect schedule -> calls connectWebSocket
            const ws2 = state.ws as MockWebSocket; // Get the new instance
            const ws2SendSpy = vi.spyOn(ws2, 'send');
            ws2._simulateOpen(); // Process connection open
            vi.advanceTimersByTime(1); // Allow open handler (incl. resubscribe) to run

            // Check if subscribe message was resent on the new connection
            expect(ws1SendSpy).not.toHaveBeenCalledWith(JSON.stringify(subMsg));
            expect(ws2SendSpy).toHaveBeenCalledWith(JSON.stringify(subMsg));
            // Note: active state is now managed by handleMessage/onStart
        });

        it('should reject pending requests on disconnect', async () => {
            connectWebSocket(state);
            (state.ws as MockWebSocket)._simulateOpen();
            vi.advanceTimersByTime(1);
            const ws1 = state.ws as MockWebSocket;

            const reqEntry: PendingRequestEntry = { resolve: vi.fn(), reject: vi.fn(), timer: setTimeout(()=>{}, 10000) };
            state.pendingRequests.set('req1', reqEntry);
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

            ws1._simulateClose(1006, 'Test disconnect');
            vi.advanceTimersByTime(1); // Process close

            expect(reqEntry.reject).toHaveBeenCalledTimes(1);
            expect(reqEntry.reject).toHaveBeenCalledWith(expect.any(Error));
            // Access arguments directly from the mock function safely
            const rejectionError = (reqEntry.reject as Mock).mock.calls[0]?.[0];
            expect(rejectionError?.message).toContain('WebSocket closed (Code: 1006, Reason: Test disconnect)');
            expect(state.pendingRequests.has('req1')).toBe(false); // Should be cleared
            expect(clearTimeoutSpy).toHaveBeenCalledWith(reqEntry.timer);
        });

         it('should mark active subscriptions as inactive on disconnect', async () => {
            connectWebSocket(state);
            (state.ws as MockWebSocket)._simulateOpen();
            vi.advanceTimersByTime(1);
            const ws1 = state.ws as MockWebSocket;

            const subEntry: ActiveSubscriptionEntry = {
                message: { id: 'sub1', type: 'subscription', path: 'test/path' }, // Add path
                handlers: { onData: vi.fn(), onError: vi.fn(), onEnd: vi.fn() },
                active: true // Mark as active
            };
            state.activeSubscriptions.set('sub1', subEntry);

            ws1._simulateClose(1006);
            vi.advanceTimersByTime(1); // Process close

            expect(subEntry.active).toBe(false);
            expect(state.activeSubscriptions.has('sub1')).toBe(true); // Should still be tracked
        });

        it('should call disconnect listeners on error', async () => {
            const disconnectListener = vi.fn();
            state.disconnectListeners.add(disconnectListener);
            connectWebSocket(state);
            (state.ws as MockWebSocket)._simulateError(new Error('Test Error'));
            vi.advanceTimersByTime(1); // Process error
            // Error might trigger close, process that too
            (state.ws as MockWebSocket)._simulateClose(1006);
            vi.advanceTimersByTime(1); // Process close
            expect(disconnectListener).toHaveBeenCalledTimes(1);
        });

        it('should call disconnect listeners on close', async () => {
            const disconnectListener = vi.fn();
            state.disconnectListeners.add(disconnectListener);
            connectWebSocket(state);
            (state.ws as MockWebSocket)._simulateClose(1001);
            vi.advanceTimersByTime(1); // Process close
            expect(disconnectListener).toHaveBeenCalledTimes(1);
        });

        // Test handleMessage indirectly via connectWebSocket
        describe('handleMessage (via connectWebSocket)', () => {
             let wsInstance: MockWebSocket;

             beforeEach(() => {
                 connectWebSocket(state);
                 wsInstance = state.ws as MockWebSocket;
                 wsInstance._simulateOpen(); // Open connection
                 vi.advanceTimersByTime(1); // Allow open handler
                 // Clear mocks from connection phase
                 vi.clearAllMocks();
                 // Re-setup spies after clearing
                 vi.spyOn(console, 'log').mockImplementation(() => {});
                 vi.spyOn(console, 'warn').mockImplementation(() => {});
                 vi.spyOn(console, 'error').mockImplementation(() => {});
                 vi.spyOn(console, 'debug').mockImplementation(() => {});
             });

             it('should resolve pending request on result message', () => {
                 const reqEntry: PendingRequestEntry = { resolve: vi.fn(), reject: vi.fn() };
                 state.pendingRequests.set('req123', reqEntry);
                 // Correct structure for ProcedureResultMessage
                 const resultMsg: ProcedureResultMessage = { id: 'req123', result: { type: 'data', data: 'Success!' } };

                 wsInstance._simulateMessage(state.serializer(resultMsg));
                 vi.advanceTimersByTime(1); // Allow message handler

                 expect(reqEntry.resolve).toHaveBeenCalledTimes(1);
                 expect(reqEntry.resolve).toHaveBeenCalledWith(resultMsg);
                 expect(reqEntry.reject).not.toHaveBeenCalled();
                 expect(state.pendingRequests.has('req123')).toBe(false);
             });

             it('should reject pending request on error result message', () => {
                 const reqEntry: PendingRequestEntry = { resolve: vi.fn(), reject: vi.fn() };
                 state.pendingRequests.set('req456', reqEntry);
                 // Correct structure for ProcedureResultMessage
                 const errorMsg: ProcedureResultMessage = { id: 'req456', result: { type: 'error', error: { message: 'It failed' } } };

                 wsInstance._simulateMessage(state.serializer(errorMsg));
                 vi.advanceTimersByTime(1); // Allow message handler

                 expect(reqEntry.reject).toHaveBeenCalledTimes(1);
                 expect(reqEntry.reject).toHaveBeenCalledWith(expect.any(Error));
                 // Access arguments directly from the mock function safely
                 const rejectionError = (reqEntry.reject as Mock).mock.calls[0]?.[0];
                 expect(rejectionError?.message).toBe('It failed');
                 expect(reqEntry.resolve).not.toHaveBeenCalled();
                 expect(state.pendingRequests.has('req456')).toBe(false);
             });

             it('should call onAckReceived handler on ack message', () => {
                 const ackHandler = vi.fn();
                 state.options.onAckReceived = ackHandler; // Assign handler to options
                 // Remove incorrect 'id' property
                 const ackMsg = { type: 'ack', clientSeq: 5, serverSeq: 10 };

                 wsInstance._simulateMessage(state.serializer(ackMsg));
                 vi.advanceTimersByTime(1); // Allow message handler

                 expect(ackHandler).toHaveBeenCalledTimes(1);
                 expect(ackHandler).toHaveBeenCalledWith(ackMsg);
             });

             it('should call subscription data handler and onStart', () => {
                 const handlers: InternalSubscriptionHandlers = { onData: vi.fn(), onError: vi.fn(), onEnd: vi.fn(), onStart: vi.fn() };
                 const subEntry: ActiveSubscriptionEntry = { message: { id: 'subX', type: 'subscription', path: 'test/path/x' }, handlers, active: false }; // Add path
                 state.activeSubscriptions.set('subX', subEntry);
                 // Add missing serverSeq property
                 const dataMsg: SubscriptionDataMessage = { id: 'subX', type: 'subscriptionData', serverSeq: 1, data: { value: 1 } };

                 wsInstance._simulateMessage(state.serializer(dataMsg));
                 vi.advanceTimersByTime(1); // Allow message handler

                 expect(handlers.onData).toHaveBeenCalledTimes(1);
                 expect(handlers.onData).toHaveBeenCalledWith(dataMsg);
                 expect(handlers.onStart).toHaveBeenCalledTimes(1); // Should also call onStart
                 expect(subEntry.active).toBe(true); // Should be marked active
             });

             it('should call subscription error handler and remove subscription', () => {
                 const handlers: InternalSubscriptionHandlers = { onData: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
                 const subEntry: ActiveSubscriptionEntry = { message: { id: 'subY', type: 'subscription', path: 'test/path/y' }, handlers, active: true }; // Add path
                 state.activeSubscriptions.set('subY', subEntry);
                 const errorMsg: SubscriptionErrorMessage = { id: 'subY', type: 'subscriptionError', error: { message: 'Sub failed' } };

                 wsInstance._simulateMessage(state.serializer(errorMsg));
                 vi.advanceTimersByTime(1); // Allow message handler

                 expect(handlers.onError).toHaveBeenCalledTimes(1);
                 expect(handlers.onError).toHaveBeenCalledWith(errorMsg.error);
                 expect(handlers.onData).not.toHaveBeenCalled();
                 expect(handlers.onEnd).not.toHaveBeenCalled();
                 expect(state.activeSubscriptions.has('subY')).toBe(false); // Should be removed
             });

             it('should call subscription end handler and remove subscription', () => {
                 const handlers: InternalSubscriptionHandlers = { onData: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
                 const subEntry: ActiveSubscriptionEntry = { message: { id: 'subZ', type: 'subscription', path: 'test/path/z' }, handlers, active: true }; // Add path
                 state.activeSubscriptions.set('subZ', subEntry);
                 const endMsg: SubscriptionEndMessage = { id: 'subZ', type: 'subscriptionEnd' };

                 wsInstance._simulateMessage(state.serializer(endMsg));
                 vi.advanceTimersByTime(1); // Allow message handler

                 expect(handlers.onEnd).toHaveBeenCalledTimes(1);
                 expect(handlers.onError).not.toHaveBeenCalled();
                 expect(handlers.onData).not.toHaveBeenCalled();
                 expect(state.activeSubscriptions.has('subZ')).toBe(false); // Should be removed
             });

             it('should warn on uncorrelated message', () => {
                 const msg = { id: 'unknown', type: 'random' };
                 wsInstance._simulateMessage(state.serializer(msg));
                 vi.advanceTimersByTime(1); // Allow message handler
                 expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Received uncorrelated or unknown message'), msg);
             });

             it('should handle deserialization errors gracefully', () => {
                 const invalidJson = '{ "bad" json ';
                 wsInstance._simulateMessage(invalidJson); // Send raw invalid string
                 vi.advanceTimersByTime(1); // Allow message handler
                 expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Deserialization error'), expect.any(Error), invalidJson);
                 // Ensure no handlers were called incorrectly
                 expect(state.pendingRequests.size).toBe(0);
                 // Check handlers on existing subs if any were added in other tests
                 state.activeSubscriptions.forEach(sub => {
                     expect(sub.handlers.onData).not.toHaveBeenCalled();
                     expect(sub.handlers.onError).not.toHaveBeenCalled();
                     // onEnd might be called by cleanup, depends on test structure
                 });
             });
        });

    });

    describe('disconnectWebSocket', () => {
        beforeEach(() => {
            // Ensure connected state
            connectWebSocket(state);
            (state.ws as MockWebSocket)._simulateOpen();
            vi.advanceTimersByTime(1);
            expect(state.isConnected).toBe(true);
            expect(state.ws).toBeInstanceOf(MockWebSocket);
             // Clear mocks from connection phase
             vi.clearAllMocks();
             // Re-setup spies after clearing
             vi.spyOn(console, 'log').mockImplementation(() => {});
             vi.spyOn(console, 'warn').mockImplementation(() => {});
             vi.spyOn(console, 'error').mockImplementation(() => {});
             vi.spyOn(console, 'debug').mockImplementation(() => {});
        });

        it('should call ws.close with code and reason', () => {
            const closeSpy = vi.spyOn(state.ws!, 'close');
            disconnectWebSocket(state, 1000, 'User logout');
            expect(closeSpy).toHaveBeenCalledTimes(1);
            expect(closeSpy).toHaveBeenCalledWith(1000, 'User logout');
        });

        it('should set isConnected to false and update listeners', () => {
            const listener = vi.fn();
            state.connectionChangeListeners.add(listener);
            disconnectWebSocket(state);
            // Close is async in mock, advance timer
            vi.advanceTimersToNextTimer();
            expect(state.isConnected).toBe(false);
            expect(listener).toHaveBeenCalledTimes(1); // Changed from true -> false
            expect(listener).toHaveBeenCalledWith(false);
        });

        it('should clear pending requests and reject them', () => {
            const reqEntry: PendingRequestEntry = { resolve: vi.fn(), reject: vi.fn(), timer: setTimeout(()=>{}, 1000) };
            state.pendingRequests.set('req1', reqEntry);
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

            disconnectWebSocket(state);
            vi.advanceTimersToNextTimer(); // Allow disconnect to process

            expect(state.pendingRequests.size).toBe(0);
            expect(reqEntry.reject).toHaveBeenCalledTimes(1);
            expect(reqEntry.reject).toHaveBeenCalledWith(expect.any(Error));
            // Access arguments directly from the mock function safely
            const rejectionError = (reqEntry.reject as Mock).mock.calls[0]?.[0];
            expect(rejectionError?.message).toContain('Transport disconnected by user');
            expect(clearTimeoutSpy).toHaveBeenCalledWith(reqEntry.timer);
        });

        it('should clear active subscriptions and call onEnd', () => {
            const handlers: InternalSubscriptionHandlers = { onData: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
            const subEntry: ActiveSubscriptionEntry = { message: { id: 'sub1', type: 'subscription', path: 'test/path' }, handlers, active: true }; // Add path
            state.activeSubscriptions.set('sub1', subEntry);

            disconnectWebSocket(state);
            vi.advanceTimersToNextTimer(); // Allow disconnect to process

            expect(state.activeSubscriptions.size).toBe(0);
            expect(handlers.onEnd).toHaveBeenCalledTimes(1); // Should signal end to iterator
        });

        it('should prevent automatic reconnection', () => {
            // Simulate a pending reconnect timer
            state.reconnectTimeoutId = setTimeout(() => {}, 5000);
            const timerId = state.reconnectTimeoutId;
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

            disconnectWebSocket(state);
            vi.advanceTimersToNextTimer(); // Allow disconnect to process

            expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId); // Should clear pending timer
            expect(state.reconnectAttempts).toBe(DEFAULT_MAX_RECONNECT_ATTEMPTS); // Set to max to prevent future attempts
        });

        it('should nullify WebSocket instance and connection promise', () => {
            disconnectWebSocket(state);
            vi.advanceTimersToNextTimer(); // Allow disconnect to process
            expect(state.ws).toBeNull();
            expect(state.connectionPromise).toBeNull();
        });

        it('should call disconnect listeners', () => {
            const listener = vi.fn();
            state.disconnectListeners.add(listener);
            disconnectWebSocket(state);
            vi.advanceTimersToNextTimer(); // Allow disconnect to process
            // Disconnect listeners are called *after* state is cleaned up
            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('should handle closing when already closed/closing gracefully', () => {
             (state.ws! as MockWebSocket).readyState = CLOSED; // Cast to allow assignment
             const closeSpy = vi.spyOn(state.ws!, 'close');
             disconnectWebSocket(state);
             vi.advanceTimersToNextTimer(); // Allow disconnect to process
             expect(closeSpy).not.toHaveBeenCalled(); // Should not attempt to close again
             expect(state.isConnected).toBe(false); // Should still ensure state is false
        });
    });
});