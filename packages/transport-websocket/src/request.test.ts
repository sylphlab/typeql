// packages/transport-websocket/src/request.test.ts

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'; // Import Mock type
// Removed duplicate imports (Mock, connectionModule, OPEN)
import type { ConnectionState, WebSocketTransportOptions, ProcedureCallMessage, ProcedureResultMessage, WebSocketLike } from './types'; // Added WebSocketLike
import { handleRequest } from './request';
// connectionModule is imported by the vi.mock factory below
import * as connectionModule from './connection'; // Import for mock verification/access

// Mock the connection module
vi.mock('./connection', async (importOriginal) => {
  const actual = await importOriginal<typeof connectionModule>();
  return {
    ...actual,
    connectWebSocket: vi.fn(),
    sendMessage: vi.fn(),
    // Keep other original functions like updateConnectionStatus if needed indirectly
  };
});

import { defaultSerializer, defaultDeserializer } from './serialization';
import { OPEN, CLOSED, DEFAULT_REQUEST_TIMEOUT_MS } from './constants'; // Keep OPEN here

// Removed redundant synchronous vi.mock block


// Helper to create default state, similar to connection.test.ts but simpler
const createDefaultState = (options: Partial<WebSocketTransportOptions> = {}, connected = true): ConnectionState => {
    const opts: WebSocketTransportOptions = {
        url: 'ws://request-test.com',
        ...options,
    };
    // Mock WebSocket-like object for state
    const mockWs: WebSocketLike | null = connected ? {
    // Removed misplaced mock clearing lines

        readyState: OPEN,
        send: vi.fn(),
        close: vi.fn(),
        onopen: null,
        onerror: null,
        onclose: null,
        onmessage: null,
    } : null;

    const state: ConnectionState = {
        ws: mockWs,
        isConnected: connected,
        connectionPromise: connected ? Promise.resolve() : null, // Simulate resolved promise if connected
        reconnectAttempts: 0,
        reconnectTimeoutId: undefined,
        options: opts,
        WebSocketImplementation: vi.fn() as any, // Mock implementation
        serializer: opts.serializer ?? defaultSerializer,
        deserializer: opts.deserializer ?? defaultDeserializer,
        pendingRequests: new Map(),
        activeSubscriptions: new Map(),
        connectionChangeListeners: new Set(),
        disconnectListeners: new Set(),
        // Dummy functions, mocks are used via vi.mock above
        updateConnectionStatus: vi.fn(),
        // Use the mock function via the imported module
        sendMessage: (payload: any) => (connectionModule.sendMessage as Mock)(state, payload),
        scheduleReconnect: vi.fn(), // Not directly tested here, keep simple mock
    };
    return state;
};

describe('request', () => {
    let state: ConnectionState;
    // Mocks are no longer imported via vi.doMock
    // Tests will need refactoring or removal if they relied heavily on those mocks.

    beforeEach(async () => {
        vi.useFakeTimers(); // RE-ENABLED
        state = createDefaultState();
        // Clear mocks using the imported module reference
        (connectionModule.connectWebSocket as Mock).mockClear().mockResolvedValue(undefined);
        (connectionModule.sendMessage as Mock).mockClear().mockReturnValue(true);
        vi.spyOn(console, 'error').mockImplementation(() => {}); // Suppress errors during tests
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers(); // RE-ENABLED
    });

    // NOTE: Many tests below will likely fail or need significant refactoring
    // as they relied on the mocked connectWebSocket and sendMessage.
    // Focusing on fixing integration tests first. Skipping these for now. - Now fixing these.

    it('should call connectWebSocket if not connected', async () => { // Unskipped
        state = createDefaultState({}, false); // Start disconnected
        const message: ProcedureCallMessage = { id: 'req1', type: 'query', path: 'test.get' };
        // sendMessage mock is already cleared and set to return true in beforeEach
        handleRequest(state, message).catch(() => {}); // Catch potential rejection
        // Check the mock function via import
        expect(connectionModule.connectWebSocket).toHaveBeenCalledTimes(1);
        expect(connectionModule.connectWebSocket).toHaveBeenCalledWith(state);
    });

    it('should throw if connection fails', async () => { // Unskipped
        state = createDefaultState({}, false); // Start disconnected
        const connectError = new Error("Connection refused");
        (connectionModule.connectWebSocket as Mock).mockRejectedValue(connectError); // Configure mock via import
        const message: ProcedureCallMessage = { id: 'req2', type: 'query', path: 'test.get' };
        await expect(handleRequest(state, message)).rejects.toThrow("Connection refused");
        expect(connectionModule.connectWebSocket).toHaveBeenCalledTimes(1); // Check mock via import
    });

     it('should throw if connection promise resolves but state is still not OPEN', async () => { // Unskipped
        state = createDefaultState({}, false); // Start disconnected
        (connectionModule.connectWebSocket as Mock).mockImplementation(async (s) => { // Configure mock via import
            // Simulate promise resolving but state remaining disconnected
            s.connectionPromise = Promise.resolve();
            s.isConnected = false;
            s.ws = null;
        });
        const message: ProcedureCallMessage = { id: 'req-state-fail', type: 'query', path: 'test.get' };
        await expect(handleRequest(state, message)).rejects.toThrow("WebSocket not connected for request.");
        expect(connectionModule.connectWebSocket).toHaveBeenCalledTimes(1); // Check mock via import
    });


    it('should call mock sendMessage with the message', async () => { // Renamed test slightly
        state = createDefaultState({}, true); // Start connected
        const message: ProcedureCallMessage = { id: 'req3', type: 'query', path: 'test.get' };
        // sendMessage mock is already cleared and set to return true in beforeEach
        handleRequest(state, message).catch(() => {}); // Catch potential rejection
        expect(connectionModule.sendMessage).toHaveBeenCalledTimes(1); // Check mock via import
        // Check the mock function via import
        expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, message);
    });

    it('should add request to pendingRequests map', async () => { // Unskipped
        state = createDefaultState({}, true);
        const message: ProcedureCallMessage = { id: 'req4', type: 'query', path: 'test.get' };
        // sendMessage mock is already cleared and set to return true in beforeEach
        handleRequest(state, message).catch(() => {}); // Catch potential rejection
        expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, message); // Check mock via import
        expect(state.pendingRequests.has('req4')).toBe(true);
        const entry = state.pendingRequests.get('req4');
        expect(entry).toBeDefined();
        expect(entry?.resolve).toBeInstanceOf(Function);
        expect(entry?.reject).toBeInstanceOf(Function);
        expect(entry?.timer).toBeDefined(); // Check timer was set
    });

    it('should reject immediately if mock sendMessage returns false', async () => { // Renamed test slightly
        state = createDefaultState({}, true);
        (connectionModule.sendMessage as Mock).mockReturnValue(false); // Configure mock via import
        const message: ProcedureCallMessage = { id: 'req5', type: 'query', path: 'test.get' };
        await expect(handleRequest(state, message)).rejects.toThrow('Failed to send request message immediately (ID: req5)');
        expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, message); // Check mock via import
        expect(state.pendingRequests.has('req5')).toBe(false);
    });

    it('should reject after timeout', async () => { // Unskipped
        state = createDefaultState({ requestTimeoutMs: 100 }, true); // Short timeout
        // sendMessage mock is already cleared and set to return true in beforeEach
        const message: ProcedureCallMessage = { id: 'req6', type: 'query', path: 'test.get' };
        const requestPromise = handleRequest(state, message);
        expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, message); // Check mock via import
        expect(state.pendingRequests.has('req6')).toBe(true);
        const entry = state.pendingRequests.get('req6');
        expect(entry?.timer).toBeDefined(); // Check timer was set

        // Advance timer past the timeout using fake timers
        vi.advanceTimersByTime(101);

        await expect(requestPromise).rejects.toThrow('Request timed out after 100ms (ID: req6)');
    });

     it('should use default timeout if not specified', async () => { // Unskipped
        state = createDefaultState({}, true); // No timeout specified
        // sendMessage mock is already cleared and set to return true in beforeEach
        const message: ProcedureCallMessage = { id: 'req-default-timeout', type: 'query', path: 'test.get' };
        const requestPromise = handleRequest(state, message);
        expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, message); // Check mock via import
        expect(state.pendingRequests.has('req-default-timeout')).toBe(true);
        const entry = state.pendingRequests.get('req-default-timeout');
        expect(entry?.timer).toBeDefined(); // Check timer was set

        // Advance timer just under the default timeout
        vi.advanceTimersByTime(DEFAULT_REQUEST_TIMEOUT_MS - 1);
        expect(state.pendingRequests.has('req-default-timeout')).toBe(true); // Still pending

         // Advance timer past the default timeout
        vi.advanceTimersByTime(2);
        await expect(requestPromise).rejects.toThrow(`Request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms (ID: req-default-timeout)`);
        expect(state.pendingRequests.has('req-default-timeout')).toBe(false);
    });

    it('should resolve when result message is received (simulated via pendingRequests)', async () => { // Unskipped
        state = createDefaultState({}, true);
        // sendMessage mock is already cleared and set to return true in beforeEach
        const message: ProcedureCallMessage = { id: 'req7', type: 'query', path: 'test.get' };
        const result: ProcedureResultMessage = { id: 'req7', result: { type: 'data', data: 'ok' } };
        const requestPromise = handleRequest(state, message);
        expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, message); // Check mock via import
        expect(state.pendingRequests.has('req7')).toBe(true);
        const entry = state.pendingRequests.get('req7');
        expect(entry).toBeDefined();
        entry?.resolve(result); // Simulate receiving result
        await expect(requestPromise).resolves.toEqual(result);
    });

    it('should reject when error is received (simulated via pendingRequests)', async () => { // Unskipped
        state = createDefaultState({}, true);
        // sendMessage mock is already cleared and set to return true in beforeEach
        const message: ProcedureCallMessage = { id: 'req8', type: 'query', path: 'test.get' };
        const errorReason = new Error("Server error");
        const requestPromise = handleRequest(state, message);
        expect(connectionModule.sendMessage).toHaveBeenCalledWith(state, message); // Check mock via import
        expect(state.pendingRequests.has('req8')).toBe(true);
        const entry = state.pendingRequests.get('req8');
        expect(entry).toBeDefined();
        entry?.reject(errorReason); // Simulate receiving error
        await expect(requestPromise).rejects.toThrow("Server error");
        expect(state.pendingRequests.has('req8')).toBe(false); // Should be removed on reject
    });

     it('should clear timeout if resolved before timeout', async () => { // Unskipped
        state = createDefaultState({ requestTimeoutMs: 5000 }, true);
        // sendMessage mock is already cleared and set to return true in beforeEach
        const message: ProcedureCallMessage = { id: 'req9', type: 'query', path: 'test.get' };
        const result: ProcedureResultMessage = { id: 'req9', result: { type: 'data', data: 'fast' } };
        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
        const requestPromise = handleRequest(state, message);
        const entry = state.pendingRequests.get('req9');
        expect(entry?.timer).toBeDefined();
        const timerId = entry?.timer;

        entry?.resolve(result); // Resolve before timeout

        await expect(requestPromise).resolves.toEqual(result);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId); // Check timer was cleared
        expect(state.pendingRequests.has('req9')).toBe(false);

        // Advance timer past original timeout to ensure no timeout error occurs
        vi.advanceTimersByTime(6000);
        // No further assertions needed, the promise already resolved.
    });

     it('should clear timeout if rejected before timeout', async () => { // Unskipped
        state = createDefaultState({ requestTimeoutMs: 5000 }, true);
        // sendMessage mock is already cleared and set to return true in beforeEach
        const message: ProcedureCallMessage = { id: 'req10', type: 'query', path: 'test.get' };
        const errorReason = new Error("Early server error");
        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
        const requestPromise = handleRequest(state, message);
        const entry = state.pendingRequests.get('req10');
        expect(entry?.timer).toBeDefined();
        const timerId = entry?.timer;

        entry?.reject(errorReason); // Reject before timeout

        await expect(requestPromise).rejects.toThrow("Early server error");
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
        expect(state.pendingRequests.has('req10')).toBe(false);

        // Advance timer past original timeout to ensure no timeout error occurs
        vi.advanceTimersByTime(6000);
        // No further assertions needed, the promise already rejected.
    });

});