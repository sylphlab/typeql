# @sylphlab/zenquery-transport-websocket

WebSocket transport client and server handler for zenQuery.

## Installation

```bash
pnpm add @sylphlab/zenquery-transport-websocket
```

## Usage

```typescript
// Client-side Usage
import { createClient } from '@sylphlab/zenquery-client';
import { createWebSocketTransport } from '@sylphlab/zenquery-transport-websocket';
import type { AppRouter } from './server'; // Your server router type

const transport = createWebSocketTransport({ url: 'ws://localhost:3000' });
const client = createClient<AppRouter>({ transport });

// Server-side Usage (Example with ws)
import { createWebSocketHandler } from '@sylphlab/zenquery-transport-websocket/server';
import { appRouter } from './router'; // Your app router instance
import ws from 'ws';

const wss = new ws.Server({ port: 3000 });
const handler = createWebSocketHandler({ router: appRouter, createContext: async () => ({ /* ... */ }) });

wss.on('connection', (ws, req) => {
  handler({ ws, req });
});

console.log('WebSocket server started on ws://localhost:3000');
```

## Features

- Provides `createWebSocketTransport` for the client.
- Provides `createWebSocketHandler` for easy integration with Node.js WebSocket servers (like `ws`).
- Handles zenQuery message serialization/deserialization over WebSockets.
- Manages connection lifecycle and subscriptions.
- Client-side supports automatic reconnection with configurable exponential backoff.

## Development

- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Format: `pnpm format`