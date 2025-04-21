# ✨ zenQuery ✨

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
import { initZenQuery, createRouter } from '@sylphlab/zenquery-server'; // Updated import
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

// Initialize zenQuery (assuming a context type, adjust as needed)
const t = initZenQuery<any>();

const appRouter = createRouter()
  .procedure('getTodos', t.query({ // Use procedure helper
    resolve: async () => {
      return Object.values(todos);
    },
  }))
  .procedure('addTodo', t.mutation({ // Use procedure helper
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
  }))
  .procedure('onTodoUpdate', t.subscription({ // Use procedure helper
    // Output schema for the stream
    subscriptionOutput: z.array(z.any()), // Define JSON Patch schema properly later
    // Async generator for the stream
    stream: async function* () {
      // This needs proper implementation using async iterators / event listeners
      // The observable example below is from tRPC and needs adaptation
      // Conceptual:
      // const listener = createUpdateListener();
      // try {
      //   for await (const patch of listener) {
      //     yield patch;
      //   }
      // } finally {
      //   listener.cleanup();
      // }

      // Placeholder based on old example structure (needs rewrite)
      yield* observable<JsonPatchOperation[]>((emit) => {
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
      }) as any; // Cast needed as observable isn't AsyncGenerator
    }
  }));

export type AppRouter = typeof appRouter;

// --- In your server setup ---
// import { createHTTPHandler } from '@sylphlab/zenquery-transport-http/server'; // Example
// import { createWebSocketHandler } from '@sylphlab/zenquery-transport-websocket/server'; // Example
// ... create transport handler with appRouter ...
```

```typescript
 // Example Usage with Nanostores (@nanostores/react)
 
 // --- store.ts ---
 import { atom } from 'nanostores';
 import { createClient } from '@sylphlab/zenquery-client';
 import { query, mutation, effect } from '@sylphlab/zenquery-client/nanostores';
 import { createHttpTransport } from '@sylphlab/zenquery-transport-http';
 import type { AppRouter } from '../server/router'; // Your server router type
 
 // Assume Todo type is defined
 interface Todo { id: string; text: string; completed: boolean; status?: string }
 
 // 1. Client Atom
 export const $client = atom(() => // Type is inferred
   createClient<AppRouter>({
     transport: createHttpTransport({ url: '/api/zenquery', batching: true })
   })
 );
 
 // 2. Query Atom
 export const $todos = query<AppRouter['todos']['list']['_def']['_output'], Error, { limit: number }>(
   // Selector function: receives 'get', returns the procedure reference
   get => get($client).todos.list,
   // Options object: includes 'path' for registry key and procedure input
   { path: 'todos.list', input: { limit: 10 }, initialData: [] }
 );
 
 // 3. Mutation Atom
 export const $addTodo = mutation<AppRouter['todos']['add']['_def']['_input']>(
   // Selector function: returns the procedure reference
   get => get($client).todos.add, // Selector just returns the procedure
   { // Options object (NO 'path' needed)
     effects: [ // Define optimistic updates
       effect($todos, (currentTodos, input) => { // Target atom, apply patch recipe
         const tempId = `temp-${Date.now()}`;
         // Return the new state for the target atom
         return [...(currentTodos ?? []), { ...input, id: tempId, completed: false, status: 'pending' }];
       })
     ]
     // onSuccess: (result, input) => { ... },
     // onError: (error, input) => { ... },
   }
 );
 
 // 4. (Optional) Hybrid Atom using the 'hybrid' helper
 //    Combines a query atom and a subscription atom
 const $todosSub = subscription(
   get => get($client).todos.onUpdate,
   { /* input if needed */ }
 );
 const $todosHybrid = hybrid($todos, $todosSub); // Combines query and subscription
 
 // --- Component.tsx ---
 import React from 'react';
 import { useStore } from '@nanostores/react';
 import { $todos, $addTodo } from './store';
 
 function TodoManager() {
   // 4. Use atoms in component
   //    Can use the query atom directly, or the hybrid atom
   const { data: todos, loading, error, status } = useStore($todosHybrid); // Using hybrid atom
   const { mutate: addTodo, loading: isAdding } = useStore($addTodo);
 
   const handleAdd = () => {
     addTodo({ text: 'New todo via zenQuery!' });
   };
 
   if (status === 'loading' && !todos?.length) return <div>Loading...</div>;
   if (status === 'error') return <div>Error: {error?.message}</div>;
 
   return (
     <div>
       <button onClick={handleAdd} disabled={isAdding}>
         {isAdding ? 'Adding...' : 'Add Todo'}
       </button>
       <ul>
         {todos?.map(todo => (
           <li key={todo.id} style={{ opacity: todo.status === 'pending' ? 0.5 : 1 }}>
             {todo.text} {todo.status === 'pending' ? '(Sending...)' : ''}
           </li>
         ))}
       </ul>
       {/* Hybrid atom automatically reflects subscription updates */}
     </div>
   );
 }
 ```

---

## 🏗️ Project Structure

This project is a monorepo managed using `pnpm` workspaces and `Turborepo`.

*   `packages/`: Contains the core zenQuery libraries.
    *   `client/`: Core client logic (`createClient`, `OptimisticSyncCoordinator`, Nanostores bindings).
    *   `server/`: Core server logic (`initZenQuery`, `createRouter`, procedure builders).
    *   `shared/`: Types and utilities shared between client and server.
    *   `react/`: React hooks (`useQuery`, `useMutation`, `useSubscription`).
    *   `preact/`: Preact hooks.
    *   `transport-*/`: Adapters for different communication protocols (WebSocket, HTTP, VSCode).
*   `examples/`: Example applications demonstrating zenQuery usage.
    *   `web-app/`: A simple web application example.
    *   `vscode-extension/`: A VSCode extension example.

---

## 📦 Packages

*   `@sylphlab/zen-query-client`: Core client logic (`createClient`, Coordinator, Nanostores bindings).
*   `@sylphlab/zen-query-server`: Core server logic (`initZenQuery`, `createRouter`, procedure builders).
*   `@sylphlab/zen-query-shared`: Shared types and utilities.
*   `@sylphlab/zen-query-react`: React hooks (`useQuery`, `useMutation`, `useSubscription`).
*   `@sylphlab/zen-query-preact`: Preact hooks.
*   `@sylphlab/zen-query-transport-websocket`: WebSocket transport adapter.
*   `@sylphlab/zen-query-transport-http`: HTTP transport adapter (supports batching).
*   `@sylphlab/zen-query-transport-vscode`: VSCode extension transport adapter.

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