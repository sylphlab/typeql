// TODO: This is a standalone implementation due to broken workspace dependencies.
// It needs to be refactored to implement the Transport interface from @sylphlab/shared
// once the workspace issues are resolved.

type WebSocketTransportOptions = {
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  onMessage?: (data: unknown) => void;
  protocols?: string | string[];
  retryAttempts?: number;
  retryDelayMs?: number;
};

type ConnectionState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting';

export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private retriesMade = 0; // Track retries specifically

  constructor(
    private url: string,
    private options: WebSocketTransportOptions = {},
  ) {
    if (typeof WebSocket === 'undefined') {
      console.warn(
        'WebSocketTransport: Native WebSocket not found. This transport may not work in this environment without polyfills or the `ws` package for Node.js.',
      );
      // TODO: Add conditional logic or separate implementation for Node.js using 'ws'
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.state !== 'idle' && this.state !== 'closed' && this.state !== 'reconnecting') {
      console.warn(`WebSocketTransport: Cannot connect while in state: ${this.state}`);
      return;
    }

    if (typeof WebSocket === 'undefined') {
      console.error('WebSocketTransport: WebSocket API is not available.');
      this.state = 'closed';
      // Optionally call onClose if provided, though it's not a standard CloseEvent
      this.options.onClose?.({
        code: 1001, // Going Away (or a custom code)
        reason: 'WebSocket API not available',
        wasClean: false,
      } as CloseEvent);
      return;
    }

    this.state = 'connecting';
    // connectionAttempts incremented only during retries now
    console.log(`WebSocketTransport: Attempting to connect to ${this.url}...`);

    try {
      this.ws = new WebSocket(this.url, this.options.protocols);

      this.ws.onopen = () => {
        this.state = 'open';
        this.retriesMade = 0; // Reset retry counter on successful connection
        console.log(`WebSocketTransport: Connection opened to ${this.url}`);
        this.options.onOpen?.();
      };

      this.ws.onmessage = (event) => {
        try {
          // Assuming messages are JSON strings
          const data = JSON.parse(event.data);
          this.options.onMessage?.(data);
        } catch (error) {
          console.error('WebSocketTransport: Failed to parse incoming message:', error, 'Raw data:', event.data);
          // Optionally notify via onError or a specific onParseError callback
        }
      };

      this.ws.onerror = (event) => {
        console.error('WebSocketTransport: Error occurred:', event);
        this.options.onError?.(event);
        // Note: The 'close' event will usually follow an error.
      };

      this.ws.onclose = (event) => {
        console.log(`WebSocketTransport: Connection closed. Code: ${event.code}, Reason: ${event.reason}, Clean: ${event.wasClean}`);
        const previousState = this.state;
        this.state = 'closed';
        this.ws = null; // Clean up the instance

        // Only call onClose callback if not initiated by disconnect()
        if (previousState !== 'closing') {
            this.options.onClose?.(event);
            this.handleReconnection(event);
        } else {
             // If initiated by disconnect, ensure onClose is still called if desired behavior
             // This might depend on the expected semantics of the Transport interface
             this.options.onClose?.(event);
        }
      };
    } catch (error) {
      console.error(`WebSocketTransport: Failed to create WebSocket connection to ${this.url}:`, error);
      this.state = 'closed';
      // Simulate a close event for error handling consistency
       this.options.onClose?.({
        code: 1006, // Abnormal Closure
        reason: `Failed to create connection: ${error instanceof Error ? error.message : String(error)}`,
        wasClean: false,
      } as CloseEvent);
       this.handleReconnection({ code: 1006 } as CloseEvent); // Attempt reconnection even on creation error
    }
  }

  disconnect(code: number = 1000, reason: string = 'Normal closure'): void {
    if (this.state !== 'open' && this.state !== 'connecting') {
      console.warn(`WebSocketTransport: Cannot disconnect while in state: ${this.state}`);
      return;
    }

    if (this.ws) {
      console.log(`WebSocketTransport: Closing connection with code ${code}...`);
      this.state = 'closing';
      this.ws.close(code, reason);
    } else {
        // If ws is null but state is connecting, transition directly to closed
        if (this.state === 'connecting') {
            this.state = 'closed';
            console.log(`WebSocketTransport: Connection attempt cancelled.`);
             this.options.onClose?.({
                code: code,
                reason: reason,
                wasClean: false, // Connection wasn't established
            } as CloseEvent);
        }
    }
  }

  send(data: unknown): boolean {
    if (this.state !== 'open' || !this.ws) {
      console.error('WebSocketTransport: Cannot send message, connection is not open.');
      return false;
    }

    try {
      const message = JSON.stringify(data);
      this.ws.send(message);
      return true;
    } catch (error) {
      console.error('WebSocketTransport: Failed to stringify or send message:', error);
      this.options.onError?.(new ErrorEvent('senderror', { error: error, message: 'Failed to send message' }));
      return false;
    }
  }

  private handleReconnection(closeEvent: CloseEvent): void {
    // Avoid reconnection for normal closure or if explicitly disabled
    const maxRetries = this.options.retryAttempts ?? 3; // Use maxRetries for clarity
    if (closeEvent.code === 1000 || maxRetries === 0) {
        // Ensure state is definitively closed if no retry will happen
        if (this.state !== 'closed') this.state = 'closed';
        return;
    }

    const delay = this.options.retryDelayMs ?? 5000; // Default to 5 seconds

    // Allow retries if retries made so far is less than maxRetries
    if (this.retriesMade < maxRetries) {
      this.retriesMade++; // Increment before scheduling retry
      this.state = 'reconnecting';
      console.log(`WebSocketTransport: Attempting to reconnect in ${delay / 1000} seconds... (Retry ${this.retriesMade}/${maxRetries})`);
      setTimeout(() => {
        // Check state before connecting, might have been closed manually
        if (this.state === 'reconnecting') {
            this.connect();
        }
      }, delay);
    } else {
      // Ensure state is closed if max retries exceeded
      if (this.state !== 'closed') this.state = 'closed';
      console.error(`WebSocketTransport: Max reconnection retries (${maxRetries}) reached for ${this.url}.`);
    }
  }
}
