// packages/transport-websocket/src/constants.ts

// Constants for readyState (aligns with browser and 'ws')
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

// Default configuration values
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000; // 15 seconds
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
export const DEFAULT_BASE_RECONNECT_DELAY_MS = 1000; // 1 second
export const MAX_RECONNECT_DELAY_MS = 30000; // 30 seconds
export const RECONNECT_JITTER_FACTOR_MIN = 0.85;
export const RECONNECT_JITTER_FACTOR_MAX = 1.15;

// WebSocket close codes
export const CLOSE_CODE_NORMAL = 1000;
export const CLOSE_CODE_GOING_AWAY = 1001; // E.g., navigating away or client restarting connection