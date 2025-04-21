# zenQuery Client (`@sylphlab/zen-query-client`)

This package provides the core client-side logic for interacting with a zenQuery server. It allows you to create a fully typesafe client based on your server's router definition.

## Installation

```bash
pnpm add @sylphlab/zen-query-client
 # You also need to install a transport package, e.g.:
 pnpm add @sylphlab/zen-query-transport-websocket
 # And Nanostores for state integration:
 pnpm add nanostores @nanostores/react # or other framework bindings
 ```

## Basic Usage

1.  **Define your Server Router:** (See `@sylphlab/zen-query-server` documentation) Export the *type* of your router.

    ```typescript
    // server.ts (Example)
    import { initZenQuery, createRouter } from '@sylphlab/zenquery-server';
    // ... define procedures using t.query, t.mutation, t.subscription ...
    const t = initZenQuery<MyContext>();
    const appRouter = createRouter<MyContext>()({ /* ... procedures ... */ });
    export type AppRouter = typeof appRouter; // Export the type
    ```

2.  **Create the Client:** Import `createClient`, a transport implementation, and your server's `AppRouter` type.

    ```typescript
    // clientSetup.ts (Example)
    import { atom } from 'nanostores';
    import { createClient } from '@sylphlab/zen-query-client';
    import { createWebSocketTransport } from '@sylphlab/zen-query-transport-websocket'; // Choose your transport
    import type { AppRouter } from './server'; // Import the router TYPE

    // Configure and create the transport
    const transport = createWebSocketTransport({ url: 'ws://localhost:3000' });

    // Create the client instance (likely within a Nanostore atom)
    export const $client = atom(() => // Type is inferred
      createClient<AppRouter>({ transport })
    );

    // Now use the binding helpers with the client atom!
    // See usage examples with Nanostores binding helpers below
    ```

## Features & Architecture

*   **End-to-End Typesafety:** Leverages TypeScript inference from your server router.
*   **Transport Agnostic:** Works with different transport layers (WebSocket, HTTP, VSCode, etc.).
*   **Optimistic Updates & Realtime Sync:** Built-in `OptimisticSyncCoordinator` engine handles sequence numbers, pending mutations, conflict resolution, and recomputation logic.
*   **Delta-based Subscriptions:** Designed to receive and apply granular JSON Patch updates for efficient state synchronization.
*   **Nanostores Integration:** Provides helper functions (`query`, `subscription`, `mutation`, `effect`) in `@sylphlab/zen-query-client/nanostores` to seamlessly bind zenQuery operations with Nanostore atoms.

## Usage with Nanostores

```typescript
// store.ts
import { atom } from 'nanostores';
import { createClient } from '@sylphlab/zen-query-client';
import { createHttpTransport } from '@sylphlab/zen-query-transport-http';
import type { AppRouter } from '../server/router'; // Your server router type

export const $client = atom(() => // Type is inferred
  createClient<AppRouter>({
    transport: createHttpTransport({ url: '/api/zenquery', batching: true }),
    // Add other client options if needed
  })
);

// --- Binding Helpers ---
import { query, subscription, hybrid, mutation, effect } from '@sylphlab/zen-query-client/nanostores';

// Query Atom
export const $posts = query(
  // Selector function: receives 'get', returns the procedure reference
  get => get($client).posts.list,
  // Options object: input, initialData etc. (NO 'path' needed)
  { initialData: [] } // Assuming no input needed for list
);

// Mutation Atom with Optimistic Update
export const $addPost = mutation(
  // Selector function: returns the procedure reference
  get => get($client).posts.add,
  { // Options object (NO 'path' needed)
    effects: [ // Define optimistic updates
      effect($posts, (currentPosts, input) => { // Target atom, apply patch recipe
      const tempId = `temp-${Date.now()}`;
      const current = currentPosts ?? [];
      return [...current, { ...input, id: tempId, status: 'pending' }];
    }),
    // Add effects for other atoms if needed
  ],
  // onSuccess: (result, input) => { console.log('Added:', result); },
  // onError: (error, input) => { console.error('Failed:', error); },
});

// Subscription Atom (Example)
export const $postsSub = subscription(
  get => get($client).posts.onUpdate,
  { /* input if needed */ }
);

// Hybrid Atom (Combines Query and Subscription)
export const $postsHybrid = hybrid($posts, $postsSub);

// --- Component Usage (React Example) ---
import React from 'react';
import { useStore } from '@nanostores/react';
import { $posts, $addPost } from './store';

function PostManager() {
  // Use the hybrid atom to get initial data + realtime updates
  const { data: posts, loading, error, status } = useStore($postsHybrid);
  const { mutate: addPost, loading: isAdding } = useStore($addPost);

  const handleAdd = () => {
    addPost({ title: 'New Post via Nanostores', content: '...' });
  };

  // Use status for more granular loading/error states
  if (status === 'loading' && !posts?.length) return <div>Loading posts...</div>;
  if (status === 'error') return <div>Error loading posts: {error?.message}</div>;

  return (
    <div>
      <button onClick={handleAdd} disabled={isAdding}>
        {isAdding ? 'Adding...' : 'Add Post'}
      </button>
      <ul>
        {posts?.map(post => (
          <li key={post.id} style={{ opacity: post.status === 'pending' ? 0.5 : 1 }}>
            {post.title} {post.status === 'pending' ? '(Sending...)' : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

See the main project [README](../../README.md) for a higher-level overview. Check the technical guidelines (`memory-bank/zenquery_technical_guidelines_v1.md`) for detailed architecture.