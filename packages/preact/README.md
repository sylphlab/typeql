# zenQuery Preact Integration (`@sylphlab/zen-query-preact`)

This package provides Preact hooks for integrating with zenQuery and Nanostores.

## Installation

```bash
pnpm add @sylphlab/zen-query-client @sylphlab/zen-query-preact nanostores @nanostores/preact
# You also need a transport package, e.g.:
pnpm add @sylphlab/zenquery-transport-websocket
```

## Basic Usage

This package primarily works in conjunction with `@sylphlab/zen-query-client/nanostores` helpers (`query`, `mutation`, `subscription`) and `@nanostores/preact`.

1.  **Setup Client Atom:** Create a Nanostore atom to hold your zenQuery client instance.

    ```typescript
    // src/clientSetup.ts (Example)
    import { atom } from 'nanostores';
    import { createClient } from '@sylphlab/zen-query-client';
    import { createWebSocketTransport } from '@sylphlab/zenquery-transport-websocket';
    import type { AppRouter } from '../server/router'; // Your server router type

    export const $client = atom<ReturnType<typeof createClient<AppRouter>>>(() =>
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
    export const $posts = query($client, {
      query: (client) => client.posts.list.query,
      initialData: [],
    });

    // Mutation Atom
    export const $addPost = mutation($client, {
      mutation: (client) => client.posts.add.mutate,
      effects: [
        effect($posts, (currentPosts, input) => { // Target atom, apply patch recipe
          const tempId = `temp-${Date.now()}`;
          return [...currentPosts, { ...input, id: tempId, status: 'pending' }];
        }),
      ],
    });
    ```

3.  **Use in Preact Components:** Use the `useStore` hook from `@nanostores/preact` to interact with the atoms.

    ```typescript
    // src/components/PostManager.tsx (Example)
    import { h } from 'preact';
    import { useStore } from '@nanostores/preact';
    import { $posts, $addPost } from '../store';

    function PostManager() {
      const { data: posts, loading, error } = useStore($posts);
      const { mutate: addPost, loading: isAdding } = useStore($addPost);

      const handleAdd = () => {
        addPost({ title: 'New Post via Preact', content: '...' });
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

The core logic for fetching, optimistic updates, and state synchronization resides within the `@sylphlab/zen-query-client` package and its Nanostores binding helpers. This `@sylphlab/zen-query-preact` package might contain Preact-specific context providers or utility hooks in the future, but the primary interaction pattern relies on `@nanostores/preact`.