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
 // packages/client/src/nanostoresUsage.ts (Example Usage with Nanostores)
 import { atom, useStore } from '@nanostores/react'; // Or @nanostores/preact etc.
 import { createClient } from '@sylphlab/zenquery-client';
 import { query, mutation, effect } from '@sylphlab/zenquery-client/nanostores';
 import { createWebSocketTransport } from '@sylphlab/zenquery-transport-websocket';
 import type { AppRouter } from './server'; // <-- Import only the TYPE
 
 // Assume Todo type is defined
 interface Todo { id: string; text: string; completed: boolean; status?: string }
 
 // 1. Create Client Atom
 const $client = atom<ReturnType<typeof createClient<AppRouter>>>(() =>
   createClient<AppRouter>({
     transport: createWebSocketTransport({ url: 'ws://localhost:3000' })
   })
 );
 
 // 2. Create Query Atom using the 'query' helper
 const $todos = query($client, {
   query: (client) => client.todos.list.query, // Select the query procedure
   initialData: [] as Todo[], // Optional initial data
 });
 
 // 3. Create Mutation Atom using the 'mutation' helper
 const $addTodo = mutation($client, {
   mutation: (client) => client.todos.add.mutate, // Select the mutation procedure
   effects: [ // Define optimistic updates
     effect($todos, (currentTodos, input: { text: string }) => { // Target atom, recipe
       const tempId = `temp-${Date.now()}`;
       return [...currentTodos, { ...input, id: tempId, completed: false, status: 'pending' }];
     })
   ]
 });
 
 // 4. Use in Component
 function TodoList() {
   const { data: todos, loading, error } = useStore($todos);
   const { mutate: addTodo, loading: isAdding } = useStore($addTodo);
 
   const handleAdd = () => {
     addTodo({ text: 'New todo from zenQuery!' });
   };
 
   if (loading && !todos?.length) return <div>Loading...</div>;
   if (error) return <div>Error: {error.message}</div>;
 
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
       {/* Subscription updates to $todos will automatically reflect here */}
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