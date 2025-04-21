# ✨ zenQuery (@sylphlab/typeql) ✨

**Tired of REST/GraphQL boilerplate? Crave effortless, end-to-end typesafe APIs in TypeScript?**

**zenQuery is your revolution.**

Inspired by tRPC, zenQuery leverages the full power of TypeScript inference to create **zero-config, zero-codegen, truly typesafe APIs**. Define your backend logic once, and get fully typed client-side procedures instantly.

**But zenQuery goes further.** It's built from the ground up for **realtime, incremental data synchronization** via **Delta Subscriptions**.

---

## 🔥 Why zenQuery? 🔥

*   **🤯 End-to-End Typesafety:** Catch errors at compile time, not runtime. TypeScript *is* your schema.
*   **⚡️ Zero Codegen, Zero Boilerplate:** Define your API with plain TypeScript functions. No separate schema language, no build steps.
*   **🌊 Realtime Delta Subscriptions:** Efficiently sync state changes with granular, incremental updates using JSON Patch. Perfect for collaborative apps, live dashboards, and more.
*   **🚀 Optimistic Updates Built-In:** Deliver snappy UIs with automatic reconciliation and conflict resolution.
*   **🔌 Transport Agnostic:** Use WebSockets, HTTP (with batching), VSCode extensions, or bring your own transport.
*   **🧩 Composable & Flexible:** Designed with a clean core and pluggable transports/integrations.
*   **✅ Input Validation:** Built-in support for Zod schemas.
*   **🎯 Superior DX:** Focus on your logic, not the plumbing. Enjoy a seamless TypeScript experience.

---

## 🚀 Get Started (Example)

```typescript
// packages/server/src/router.ts (Example Definition)
import { createRouter, query, mutation, subscription } from '@sylphlab/typeql-server';
import { z } from 'zod';
import { observable } from '@trpc/server/observable'; // Or your preferred observable library
import { applyPatch, Operation as JsonPatchOperation } from 'rfc6902'; // JSON Patch

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

// Simple in-memory store and event emitter for the example
let todos: Record<string, Todo> = {};
const todoEvents = new EventTarget(); // Use a simple EventTarget for demo

const appRouter = createRouter()
  .query('getTodos', {
    resolve: async () => {
      return Object.values(todos);
    },
  })
  .mutation('addTodo', {
    input: z.object({ text: z.string() }),
    resolve: async ({ input }) => {
      const id = Math.random().toString(36).substring(7);
      const newTodo: Todo = { id, text: input.text, completed: false };
      todos[id] = newTodo;
      // Dispatch event for subscription
      const detail: JsonPatchOperation[] = [{ op: 'add', path: `/${id}`, value: newTodo }];
      todoEvents.dispatchEvent(new CustomEvent('update', { detail }));
      return newTodo;
    },
  })
  .subscription('onTodoUpdate', {
    resolve: () => {
      return observable<JsonPatchOperation[]>((emit) => {
        const handler = (event: Event) => {
          emit.next((event as CustomEvent).detail);
        };
        // 1. Emit initial state (optional, could also be a separate query)
        // emit.next([{ op: 'replace', path: '', value: todos }]); // Example initial state emission

        // 2. Emit deltas on change
        todoEvents.addEventListener('update', handler);
        return () => {
          todoEvents.removeEventListener('update', handler);
        };
      });
    }
  });

export type AppRouter = typeof appRouter;

// --- In your server setup ---
// import { createHTTPHandler } from '@sylphlab/typeql-transport-http/server'; // Example
// import { createWebSocketHandler } from '@sylphlab/typeql-transport-websocket/server'; // Example
// ... create transport handler with appRouter ...
```

```typescript
// packages/client/src/client.ts (Example Usage)
import { createClient } from '@sylphlab/typeql-client';
import { createWebSocketTransport } from '@sylphlab/typeql-transport-websocket'; // Example transport
import type { AppRouter } from './server'; // <-- Import only the TYPE
import { applyPatch, Operation as JsonPatchOperation } from 'rfc6902'; // JSON Patch

// Example state management (replace with your actual state logic)
let localTodos: Record<string, Todo> = {};

const transport = createWebSocketTransport({ url: 'ws://localhost:3000' }); // Configure your transport
const client = createClient<AppRouter>({ transport });

async function main() {
  // Query
  const initialTodosArray = await client.getTodos.query();
  localTodos = initialTodosArray.reduce((acc, todo) => {
    acc[todo.id] = todo;
    return acc;
  }, {} as Record<string, Todo>);
  console.log('Initial Todos:', localTodos);

  // Mutation (with optimistic update example)
  const tempId = `temp-${Math.random().toString(36).substring(7)}`;
  const optimisticTodo: Todo = { id: tempId, text: 'Buy milk', completed: false };
  const optimisticPatch: JsonPatchOperation[] = [{ op: 'add', path: `/${tempId}`, value: optimisticTodo }];

  // Apply optimistically
  applyPatch(localTodos, optimisticPatch);
  console.log('Optimistic Todos:', localTodos);

  try {
    const addedTodo = await client.addTodo.mutate(
      { text: 'Buy milk' },
      {
        // Optional: Provide optimistic update info for reconciliation
        optimisticUpdate: {
          id: tempId,
          patch: optimisticPatch,
        }
      }
    );
    console.log('Added Todo (Server Confirmed):', addedTodo);
    // Server confirmation might involve replacing tempId, handled by client/store logic
  } catch (error) {
    console.error("Mutation failed:", error);
    // Revert optimistic update if needed
    // applyPatch(localTodos, revertPatch); // Logic to generate revert patch
  }


  // Subscription
  const sub = client.onTodoUpdate.subscribe({
    onData: (delta: JsonPatchOperation[]) => {
      console.log('Received Delta:', delta);
      // Apply delta to local state
      try {
        applyPatch(localTodos, delta);
        console.log('Updated Todos:', localTodos);
      } catch (e) {
        console.error("Failed to apply delta:", e, delta);
        // Request full state refresh?
      }
    },
    onError: (err) => {
      console.error('Subscription Error:', err);
    },
    // onComplete: () => { console.log('Subscription ended'); }
  });

  console.log('Subscribed to todo updates...');

  // To unsubscribe later:
  // sub.unsubscribe();
}

main();
```

---

## 🏗️ Project Structure

This project is a monorepo managed using `pnpm` workspaces and `Turborepo`.

*   `packages/`: Contains the core zenQuery libraries.
    *   `client/`: Core client logic (`createClient`).
    *   `server/`: Core server logic (`createRouter`, procedure types).
    *   `shared/`: Types and utilities shared between client and server.
    *   `react/`: React hooks (`useQuery`, `useMutation`, `useSubscription`).
    *   `preact/`: Preact hooks.
    *   `transport-*/`: Adapters for different communication protocols (WebSocket, HTTP, VSCode).
*   `examples/`: Example applications demonstrating zenQuery usage.
    *   `web-app/`: A simple web application example.
    *   `vscode-extension/`: A VSCode extension example.

---

## 📦 Packages

*   `@sylphlab/typeql-client`: Core client logic (`createClient`).
*   `@sylphlab/typeql-server`: Core server logic (`createRouter`, procedure types).
*   `@sylphlab/typeql-shared`: Shared types and utilities.
*   `@sylphlab/typeql-react`: React hooks (`useQuery`, `useMutation`, `useSubscription`).
*   `@sylphlab/typeql-preact`: Preact hooks.
*   `@sylphlab/typeql-transport-websocket`: WebSocket transport adapter.
*   `@sylphlab/typeql-transport-http`: HTTP transport adapter (supports batching).
*   `@sylphlab/typeql-transport-vscode`: VSCode extension transport adapter.

---

## 🛠️ Development

This monorepo uses `pnpm` and `Turborepo`.

1.  **Install Dependencies:**
    ```bash
    pnpm install
    ```
2.  **Build All Packages:**
    ```bash
    pnpm run build
    ```
    *(Turborepo caches builds efficiently)*
3.  **Run Tests:**
    ```bash
    pnpm run test
    ```
4.  **Lint:**
    ```bash
    pnpm run lint
    ```
5.  **Format:**
    ```bash
    pnpm run format
    ```
6.  **Validate (Format, Lint, Typecheck, Test):**
    ```bash
    pnpm run validate
    ```

See individual package `README` files (once created) and `package.json` scripts for more specific commands.

---

## ✨ Examples

Check the `examples/` directory for practical implementations:

*   **`examples/web-app`**: Demonstrates usage with React and WebSocket transport.
*   **`examples/vscode-extension`**: Shows integration within a VSCode extension using the dedicated transport.

---

## Contributing

Contributions welcome! Please open an issue or PR. Adhere to the project's coding standards and commit conventions (Conventional Commits enforced by `commitlint`). Use the Changesets workflow (`pnpm changeset add`) to document significant changes.

---

## License

MIT