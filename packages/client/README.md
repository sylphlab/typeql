# zenQuery Client (`@sylphlab/typeql-client`)

This package provides the core client-side logic for interacting with a zenQuery server. It allows you to create a fully typesafe client based on your server's router definition.

## Installation

```bash
pnpm add @sylphlab/typeql-client
# You also need to install a transport package, e.g.:
pnpm add @sylphlab/typeql-transport-websocket
```

## Basic Usage

1.  **Define your Server Router:** (See `@sylphlab/typeql-server` documentation) Export the *type* of your router.

    ```typescript
    // server.ts (Example)
    import { createRouter } from '@sylphlab/typeql-server';
    // ... define procedures ...
    const appRouter = createRouter({ /* ... procedures ... */ });
    export type AppRouter = typeof appRouter; // Export the type
    ```

2.  **Create the Client:** Import `createClient`, a transport implementation, and your server's `AppRouter` type.

    ```typescript
    // client.ts
    import { createClient } from '@sylphlab/typeql-client';
    import { createWebSocketTransport } from '@sylphlab/typeql-transport-websocket'; // Choose your transport
    import type { AppRouter } from './server'; // Import the router TYPE

    // Configure and create the transport
    const transport = createWebSocketTransport({ url: 'ws://localhost:3000' });

    // Create the typesafe client
    const client = createClient<AppRouter>({ transport });

    // Now you can call procedures with full type safety and autocompletion!
    async function fetchData() {
      // Example Query
      const users = await client.users.list.query();
      console.log(users);

      // Example Mutation
      const newUser = await client.users.create.mutate({ name: 'Alice' });
      console.log(newUser);

      // Example Subscription
      const sub = client.posts.onUpdate.subscribe({
        onData: (delta) => {
          console.log('Received post update delta:', delta);
          // Apply delta to your local state
        },
        onError: (err) => {
          console.error('Subscription error:', err);
        }
      });

      // Unsubscribe later
      // sub.unsubscribe();
    }
    ```

## Features

*   **End-to-End Typesafety:** Leverages TypeScript inference from your server router.
*   **Transport Agnostic:** Works with different transport layers (WebSocket, HTTP, VSCode, etc.).
*   **Queries:** Fetch data using `.query()`.
*   **Mutations:** Modify data using `.mutate()`.
    *   **Optimistic Updates:** Supports providing optimistic update information (`id`, `patch`) for immediate UI feedback and automatic reconciliation.
*   **Subscriptions:** Subscribe to realtime updates using `.subscribe()`.
    *   **Delta-based:** Receives granular JSON Patch updates for efficient state synchronization.
    *   **Error Handling:** Provides `onError` callback.
    *   **Lifecycle:** Returns an object with an `unsubscribe` method.

See the main project [README](../../README.md) for a more complete example and overview.