# zenQuery React Integration (`@sylphlab/zen-query-react`)

This package provides React hooks for integrating with zenQuery and Nanostores.

## Installation

```bash
pnpm add @sylphlab/zen-query-client @sylphlab/zen-query-react nanostores @nanostores/react
# You also need a transport package, e.g.:
pnpm add @sylphlab/zenquery-transport-websocket
```

## Basic Usage

This package primarily works in conjunction with `@sylphlab/zen-query-client/nanostores` helpers (`query`, `mutation`, `subscription`) and `@nanostores/react`.

1.  **Setup Client Atom:** Create a Nanostore atom to hold your zenQuery client instance.

    ```typescript
    // src/clientSetup.ts (Example)
    import { atom } from 'nanostores';
    import { createClient } from '@sylphlab/zen-query-client';
    import { createWebSocketTransport } from '@sylphlab/zenquery-transport-websocket';
    import type { AppRouter } from '../server/router'; // Your server router type

    export const $client = atom(() => // Type is inferred
      createClient<AppRouter>({
        transport: createWebSocketTransport({ url: 'ws://...' }),
      })
    );
    ```

2.  **Create Query/Mutation/Subscription Atoms:** Use the binding helpers from `@sylphlab/zen-query-client/nanostores`.

    ```typescript
    // src/store.ts (Example)
    import { $client } from './clientSetup';
    import { query, mutation, effect } from '@sylphlab/zen-query-client/nanostores';
    import { atom } from 'nanostores'; // Import base atom if needed

    // Query Atom
    const postsSelector = (get: any) => {
      const client = get($client);
      return { client, procedure: client.posts.list, path: 'posts.list' };
    };
    export const $posts = query(postsSelector, {
      // input: undefined,
      initialData: [],
    });

    // Mutation Atom
    const addPostSelector = (get: any) => {
      const client = get($client);
      return { client, procedure: client.posts.add, path: 'posts.add' };
    };
    export const $addPost = mutation(addPostSelector, {
      effects: [
        effect($posts, (currentPosts, input) => { // Target atom, apply patch recipe
          const tempId = `temp-${Date.now()}`;
          const current = currentPosts ?? [];
          return [...current, { ...input, id: tempId, status: 'pending' }];
        }),
      ],
    });
    ```

3.  **Use in React Components:** Use the `useStore` hook from `@nanostores/react` to interact with the atoms.

    ```typescript
    // src/components/PostManager.tsx (Example)
    import React from 'react';
    import { useStore } from '@nanostores/react';
    import { $posts, $addPost } from '../store';

    function PostManager() {
      const { data: posts, loading, error } = useStore($posts);
      const { mutate: addPost, loading: isAdding } = useStore($addPost);

      const handleAdd = () => {
        addPost({ title: 'New Post via React', content: '...' });
      };

      if (loading && !posts?.length) return <div>Loading posts...</div>;
      if (error) return <div>Error loading posts: {error.message}</div>;

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

    export default PostManager;
    ```

## Note

The core logic for fetching, optimistic updates, and state synchronization resides within the `@sylphlab/zen-query-client` package and its Nanostores binding helpers. This `@sylphlab/zen-query-react` package might contain React-specific context providers or utility hooks in the future, but the primary interaction pattern relies on `@nanostores/react`.