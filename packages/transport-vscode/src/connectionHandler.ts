/**
 * Manages the connection state and related event handlers for the VSCodeTransport.
 */
export class ConnectionManager {
    private _connected = true; // Assume connected initially
    private connectionChangeHandlers = new Set<(connected: boolean) => void>();
    private disconnectHandlers = new Set<() => void>();
    private readonly triggerAttachListener: () => void;
    private readonly triggerCleanup: (reason?: string) => void;

    constructor(
        triggerAttachListener: () => void,
        triggerCleanup: (reason?: string) => void
    ) {
        this.triggerAttachListener = triggerAttachListener;
        this.triggerCleanup = triggerCleanup;
    }

    get isConnected(): boolean {
        return this._connected;
    }

    onConnectionChange(handler: (connected: boolean) => void): () => void {
        this.connectionChangeHandlers.add(handler);
        // Immediately notify current state
        handler(this._connected);
        return () => {
            this.connectionChangeHandlers.delete(handler);
        };
    }

    onDisconnect(callback: () => void): () => void {
        this.disconnectHandlers.add(callback);
        return () => {
            this.disconnectHandlers.delete(callback);
        };
    }

    connect(): void {
        if (!this._connected) {
            this._connected = true;
            this.connectionChangeHandlers.forEach(h => h(true));
            // Trigger re-attachment of the message listener in the main transport
            this.triggerAttachListener();
        }
    }

    disconnect(reason?: string): void {
        if (this._connected) {
            this._connected = false;
            // Notify handlers
            this.connectionChangeHandlers.forEach(h => h(false));
            this.disconnectHandlers.forEach(h => h());
            // Trigger cleanup in the main transport
            this.triggerCleanup(reason ?? 'Transport disconnected');
            // Note: We don't detach the listener here, assuming reconnection might happen via connect()
        }
    }
}