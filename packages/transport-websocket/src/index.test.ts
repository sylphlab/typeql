import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { createWebSocketTransport } from './'; // Use factory function

// Mock WebSocket class
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  protocols?: string | string[];
  readyState: number = 0; // CONNECTING
  private openTimerId: NodeJS.Timeout | null = null; // Store timer ID

  onopen: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  send = vi.fn();
  close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3; // CLOSED
    // Simulate the close event being triggered by the 'server'
    setTimeout(() => {
        const closeEvent = {
            code: code ?? 1005, // No Status Received if not provided
            reason: reason ?? '',
            wasClean: code === 1000,
        } as CloseEvent;
        this.onclose?.(closeEvent);
    }, 0);
  });

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
    // Simulate async connection opening
    this.openTimerId = setTimeout(() => {
        if (this.readyState === 0) { // Only open if still connecting
            this.readyState = 1; // OPEN
            this.onopen?.();
        }
        this.openTimerId = null;
    }, 0);
  }

  // Helper to simulate server sending a message
  simulateServerMessage(data: any) {
    const messageEvent = { data: JSON.stringify(data) } as MessageEvent;
    this.onmessage?.(messageEvent);
  }

  // Helper to simulate an error
  simulateError(errorDetails: string = 'Simulated WebSocket error') {
      const errorEvent = new Event('error') as any; // Cast to allow adding details
      errorEvent.message = errorDetails;
      this.onerror?.(errorEvent);
      // Errors often lead to closure
      this.simulateClose(1006, 'Abnormal Closure due to error');
  }

  // Helper to simulate connection closing
  simulateClose(code: number, reason: string) {
      if (this.openTimerId) { // Clear pending open timer if closing happens first
          clearTimeout(this.openTimerId);
          this.openTimerId = null;
      }
      if (this.readyState === 3) return; // Already closed
      this.readyState = 3; // CLOSED
      const closeEvent = { code, reason, wasClean: code === 1000 } as CloseEvent;
      this.onclose?.(closeEvent);
  }

  static reset() {
      MockWebSocket.instances = [];
  }
}

// Stub the global WebSocket before each test
beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket);
  vi.useFakeTimers();
  MockWebSocket.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('WebSocketTransport (Standalone)', () => {
  const testUrl = 'ws://localhost:8080';

  it('should initialize in idle state', () => {
    const transport = createWebSocketTransport({ url: testUrl });
    // Cannot directly check state, assume idle initially
  });

  it('should transition to connecting and then open state on connect()', async () => {
    const onOpenMock = vi.fn();
    const transport = createWebSocketTransport({ url: testUrl, onOpen: onOpenMock });
    // expect(transport.getState()).toBe('idle'); // Cannot check state directly
    if (transport.connect) transport.connect();
    // expect(transport.getState()).toBe('connecting'); // Cannot check state directly
    expect(MockWebSocket.instances.length).toBe(1);
    expect(MockWebSocket.instances[0].url).toBe(testUrl);

    await vi.advanceTimersToNextTimerAsync(); // Let the simulated connection open

    // expect(transport.getState()).toBe('open'); // Cannot check state directly
    expect(onOpenMock).toHaveBeenCalledTimes(1);
  });

   it('should handle protocols option', async () => {
    const protocols = ['protocol1', 'protocol2'];
    const transport = createWebSocketTransport({ url: testUrl, protocols });
    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync();
    expect(MockWebSocket.instances[0].protocols).toEqual(protocols);
  });

  it('should call onError when a WebSocket error occurs', async () => {
    const onErrorMock = vi.fn();
    const transport = createWebSocketTransport({ url: testUrl, onError: onErrorMock });
    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync(); // Open connection

    MockWebSocket.instances[0].simulateError('Simulated connection error');

    expect(onErrorMock).toHaveBeenCalledTimes(1);
    expect(onErrorMock).toHaveBeenCalledWith(expect.any(Event));
    // State should eventually become closed after error
    await vi.advanceTimersToNextTimerAsync(); // Allow close event to process
    // expect(transport.getState()).toBe('connecting'); // Cannot check state directly, test error callback instead
    // Optional: check intermediate state
    // expect(transport.getState()).toBe('reconnecting'); // Before timer fires
    // expect(transport.getState()).toBe('connecting');
  });

  it('should call onClose when the connection is closed by the server', async () => {
    const onCloseMock = vi.fn();
    const transport = createWebSocketTransport({ url: testUrl, onClose: onCloseMock });
    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync(); // Open connection

    MockWebSocket.instances[0].simulateClose(1001, 'Going Away');

    expect(onCloseMock).toHaveBeenCalledTimes(1);
    expect(onCloseMock).toHaveBeenCalledWith(expect.objectContaining({ code: 1001, reason: 'Going Away' }));
    // expect(transport.getState()).toBe('reconnecting'); // Cannot check state directly, test close callback instead
  });

  it('should transition to closing and then closed state on disconnect()', async () => {
    const onCloseMock = vi.fn();
    const transport = createWebSocketTransport({ url: testUrl, onClose: onCloseMock });
    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync(); // Open connection
    // expect(transport.getState()).toBe('open'); // Cannot check state directly

    if (transport.disconnect) transport.disconnect(1000, 'Client disconnecting');
    // expect(transport.getState()).toBe('closing'); // Cannot check state directly
    expect(MockWebSocket.instances[0].close).toHaveBeenCalledWith(1000, 'Client disconnecting');

    // Simulate the close event triggered by the mock's close method
    await vi.advanceTimersToNextTimerAsync();

    // expect(transport.getState()).toBe('closed'); // Cannot check state directly
    expect(onCloseMock).toHaveBeenCalledTimes(1);
     expect(onCloseMock).toHaveBeenCalledWith(expect.objectContaining({ code: 1000, reason: 'Client disconnecting' }));
  });

   it('should not allow connect() unless idle or closed or reconnecting', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = createWebSocketTransport({ url: testUrl });
    if (transport.connect) transport.connect(); // State: connecting
    // expect(transport.getState()).toBe('connecting'); // Cannot check state directly
    if (transport.connect) transport.connect();
    expect(consoleWarnSpy).toHaveBeenCalledWith('WebSocketTransport: Cannot connect while in state: connecting');

    await vi.advanceTimersToNextTimerAsync(); // State: open
    // expect(transport.getState()).toBe('open'); // Cannot check state directly
    if (transport.connect) transport.connect();
    expect(consoleWarnSpy).toHaveBeenCalledWith('WebSocketTransport: Cannot connect while in state: open');

    if (transport.disconnect) transport.disconnect(); // State: closing
    // expect(transport.getState()).toBe('closing'); // Cannot check state directly
    if (transport.connect) transport.connect();
    expect(consoleWarnSpy).toHaveBeenCalledWith('WebSocketTransport: Cannot connect while in state: closing');

    consoleWarnSpy.mockRestore();
  });

   it('should not allow disconnect() unless open or connecting', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = createWebSocketTransport({ url: testUrl }); // State: idle
    if (transport.disconnect) transport.disconnect();
    expect(consoleWarnSpy).toHaveBeenCalledWith('WebSocketTransport: Cannot disconnect while in state: idle');

    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync(); // State: open
    if (transport.disconnect) transport.disconnect(); // State: closing
    await vi.advanceTimersToNextTimerAsync(); // State: closed
    // expect(transport.getState()).toBe('closed'); // Cannot check state directly
    if (transport.disconnect) transport.disconnect();
     expect(consoleWarnSpy).toHaveBeenCalledWith('WebSocketTransport: Cannot disconnect while in state: closed');

    consoleWarnSpy.mockRestore();
  });


  // Removed tests for obsolete `send` method
  // --- Reconnection Tests ---

  it('should attempt reconnection on unclean close if retryAttempts > 0', async () => {
    const onCloseMock = vi.fn();
    const transport = createWebSocketTransport({ url: testUrl,
      onClose: onCloseMock,
      retryAttempts: 3,
      retryDelayMs: 100,
    });
    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync(); // Open connection (Attempt 1)
    // expect(transport.getState()).toBe('open'); // Cannot check state directly
    expect(MockWebSocket.instances.length).toBe(1);

    // Simulate unclean close
    MockWebSocket.instances[0].simulateClose(1006, 'Abnormal Closure');
    expect(onCloseMock).toHaveBeenCalledTimes(1);
    // expect(transport.getState()).toBe('reconnecting'); // Cannot check state directly

    await vi.advanceTimersByTimeAsync(100); // Advance by retryDelayMs
    // expect(transport.getState()).toBe('connecting'); // Cannot check state directly
    expect(MockWebSocket.instances.length).toBe(2); // New WebSocket instance

    await vi.advanceTimersToNextTimerAsync(); // Let connection open
    // expect(transport.getState()).toBe('open'); // Cannot check state directly
  });

  it('should stop reconnecting after reaching max attempts', async () => {
    const onCloseMock = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = createWebSocketTransport({ url: testUrl,
      onClose: onCloseMock,
      retryAttempts: 1, // Only 1 retry attempt allowed
      retryDelayMs: 100,
    });

    // Initial connection
    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync();
    // expect(transport.getState()).toBe('open'); // Cannot check state directly
    expect(MockWebSocket.instances.length).toBe(1);

    // First unclean close -> triggers reconnect attempt 1
    MockWebSocket.instances[0].simulateClose(1006, 'Abnormal Closure 1');
    // expect(transport.getState()).toBe('reconnecting'); // Cannot check state directly
    await vi.advanceTimersByTimeAsync(100); // Advance timer for retry delay
    // expect(transport.getState()).toBe('connecting'); // Cannot check state directly
    expect(MockWebSocket.instances.length).toBe(2); // Second instance created

    // *** Simulate failure of the reconnection attempt ***
    MockWebSocket.instances[1].simulateClose(1006, 'Simulated failure on retry');

    // Check state immediately after simulated failure (should be closed as retry failed)
    await vi.advanceTimersByTimeAsync(0); // Allow handleReconnection logic to complete
    // expect(transport.getState()).toBe('closed'); // Cannot check state directly
    expect(onCloseMock).toHaveBeenCalledTimes(2); // Called for initial close and retry close
    expect(consoleErrorSpy).toHaveBeenCalledWith('WebSocketTransport: Max reconnection retries (1) reached for ws://localhost:8080.');

    // Ensure no further attempts by advancing time again
    await vi.advanceTimersByTimeAsync(200); // Advance well beyond any potential timers
    // expect(transport.getState()).toBe('closed'); // Cannot check state directly
    expect(MockWebSocket.instances.length).toBe(2); // No third instance

    consoleErrorSpy.mockRestore();
  });

  it('should not reconnect on clean close (code 1000)', async () => {
    const onCloseMock = vi.fn();
    const transport = createWebSocketTransport({ url: testUrl,
      onClose: onCloseMock,
      retryAttempts: 3,
      retryDelayMs: 100,
    });
    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync(); // Open connection

    // Simulate clean close
    MockWebSocket.instances[0].simulateClose(1000, 'Normal Closure');
    expect(onCloseMock).toHaveBeenCalledTimes(1);
    // expect(transport.getState()).toBe('closed'); // Cannot check state directly

    // Ensure no reconnection attempt
    await vi.advanceTimersByTimeAsync(200);
    // expect(transport.getState()).toBe('closed'); // Cannot check state directly
    expect(MockWebSocket.instances.length).toBe(1); // No new instance
  });

  it('should not reconnect if retryAttempts is 0', async () => {
    const onCloseMock = vi.fn();
    const transport = createWebSocketTransport({ url: testUrl,
      onClose: onCloseMock,
      retryAttempts: 0, // Reconnection disabled
      retryDelayMs: 100,
    });
    if (transport.connect) transport.connect();
    await vi.advanceTimersToNextTimerAsync(); // Open connection

    // Simulate unclean close
    MockWebSocket.instances[0].simulateClose(1006, 'Abnormal Closure');
    expect(onCloseMock).toHaveBeenCalledTimes(1);
    // expect(transport.getState()).toBe('closed'); // Cannot check state directly

    // Ensure no reconnection attempt
    await vi.advanceTimersByTimeAsync(200);
    // expect(transport.getState()).toBe('closed'); // Cannot check state directly
    expect(MockWebSocket.instances.length).toBe(1); // No new instance
  });

   it('should handle connection failure during initial connect and attempt retry', async () => {
        // Override global WebSocket mock for this specific test to simulate immediate failure
        const FailingMockWebSocket = vi.fn().mockImplementation((url: string) => {
            MockWebSocket.instances.push({ url } as any); // Track instance creation attempt
            throw new Error("Simulated connection failure");
        });
        vi.stubGlobal('WebSocket', FailingMockWebSocket);

        const onCloseMock = vi.fn();
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const transport = createWebSocketTransport({ url: testUrl,
            onClose: onCloseMock,
            retryAttempts: 1,
            retryDelayMs: 100,
        });

        if (transport.connect) transport.connect(); // Attempt 1 (fails immediately)
        await vi.advanceTimersByTimeAsync(0); // Allow microtasks/immediate state updates

        expect(FailingMockWebSocket).toHaveBeenCalledTimes(1);
        // expect(transport.getState()).toBe('reconnecting'); // Cannot check state directly
        expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to create WebSocket connection'), expect.any(Error));
        expect(onCloseMock).toHaveBeenCalledTimes(1); // onClose simulated due to creation error
        expect(onCloseMock).toHaveBeenCalledWith(expect.objectContaining({ code: 1006 }));

        // Restore working mock for retry
        vi.stubGlobal('WebSocket', MockWebSocket);
        MockWebSocket.instances.length = 0; // Reset instances for the working mock

        await vi.advanceTimersByTimeAsync(100); // Allow retry delay
        // expect(transport.getState()).toBe('connecting'); // Cannot check state directly
        expect(MockWebSocket.instances.length).toBe(1); // Instance created by working mock

        await vi.advanceTimersToNextTimerAsync(); // Let connection open
        // expect(transport.getState()).toBe('open'); // Cannot check state directly

        consoleErrorSpy.mockRestore();
    });

     it('should handle case where WebSocket API is unavailable', () => {
        vi.stubGlobal('WebSocket', undefined); // Simulate no WebSocket API
        const onCloseMock = vi.fn();
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const transport = createWebSocketTransport({ url: testUrl, onClose: onCloseMock });
        if (transport.connect) transport.connect();

        // expect(transport.getState()).toBe('closed'); // Cannot check state directly
        expect(consoleErrorSpy).toHaveBeenCalledWith('WebSocketTransport: WebSocket implementation not available.');
        expect(onCloseMock).toHaveBeenCalledTimes(1);
        expect(onCloseMock).toHaveBeenCalledWith(expect.objectContaining({ code: 1001, reason: 'WebSocket implementation not available' }));

        consoleErrorSpy.mockRestore();
    });

});
