# ✨ TypeQL (@sylphlab/typeql) ✨

**Tired of REST/GraphQL boilerplate? Crave effortless, end-to-end typesafe APIs in TypeScript?**

**TypeQL is your revolution.**

Inspired by tRPC, TypeQL leverages the full power of TypeScript inference to create **zero-config, zero-codegen, truly typesafe APIs**. Define your backend logic once, and get fully typed client-side procedures instantly.

**But TypeQL goes further.** It's built from the ground up for **realtime, incremental data synchronization** via **Delta Subscriptions**.

---

## 🔥 Why TypeQL? 🔥

*   **🤯 End-to-End Typesafety:** Catch errors at compile time, not runtime. TypeScript *is* your schema.
*   **⚡️ Zero Codegen, Zero Boilerplate:** Define your API with plain TypeScript functions. No separate schema language, no build steps.
*   **🌊 Realtime Delta Subscriptions:** Efficiently sync state changes with granular, incremental updates. Perfect for collaborative apps, live dashboards, and more.
*   **🚀 Optimistic Updates Built-In:** Deliver snappy UIs with automatic reconciliation.
*   **🔌 Transport Agnostic:** Use WebSockets, HTTP, VSCode extensions, or bring your own transport.
*   **🧩 Composable & Flexible:** Designed with a clean core and pluggable transports/integrations.
*   **🎯 Superior DX:** Focus on your logic, not the plumbing. Enjoy a seamless TypeScript experience.

---

## 🚀 Get Started (Conceptual)

```typescript
// server.ts
import { createRouter, query, subscription } from '@sylphlab/typeql-core';
import { z } from 'zod';
import { applyStandardDelta, StandardDelta } from '@sylphlab/typeql-core'; // Assuming delta utils

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

let todos: Record<string, Todo> = {}; // Your data source

// Define event emitter or similar for backend changes
const todoEvents = new EventEmitter<{ 'update': { id: string; delta: StandardDelta<Todo> } }>();

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
      // Generate delta and emit
      const delta: StandardDelta<Todo> = [{ op: 'add', path: `/${id}`, value: newTodo }];
      todoEvents.emit('update', { id, delta });
      return newTodo;
    },
  })
  .subscription('onTodoUpdate', {
    resolve: async function*() {
      // 1. Yield initial state (optional)
      yield Object.values(todos);

      // 2. Yield deltas on change
      for await (const { delta } of todoEvents.on('update')) {
        yield delta; // Yield the granular delta
      }
    }
  });

export type AppRouter = typeof appRouter;

// ... setup transport (e.g., WebSocket) and request handler ...
```

```typescript
// client.ts
import { createClient } from '@sylphlab/typeql-core';
import { createWebSocketTransport } from '@sylphlab/typeql-transport-websocket';
import type { AppRouter } from './server'; // <-- Import only the TYPE

const transport = createWebSocketTransport({ url: 'ws://localhost:3000' });
const client = createClient<AppRouter>({ transport });

async function main() {
  // Query
  const initialTodos = await client.getTodos.query();
  console.log('Initial Todos:', initialTodos);

  // Mutation (with optimistic update example)
  const newTodoOptimistic = { id: 'temp-id', text: 'Buy milk', completed: false };
  const addedTodo = await client.addTodo.mutate(
    { text: 'Buy milk' },
    {
      optimisticUpdate: (currentState) => {
        // Apply predicted change locally
        return applyStandardDelta(currentState, [{ op: 'add', path: '/temp-id', value: newTodoOptimistic }]);
      }
    }
  );
  console.log('Added Todo (Server Confirmed):', addedTodo);

  // Subscription
  const sub = client.onTodoUpdate.subscribe();

  // Handle initial data (if yielded by server)
  const initialState = await sub.initialData;
  if (initialState) {
    console.log('Subscription Initial State:', initialState);
    // Update local state
  }

  // Handle delta stream
  for await (const delta of sub.delta) {
    console.log('Received Delta:', delta);
    // Apply delta to local state
    // Your state management logic here...
  }
}

main();
```

---

## 📦 Packages

*   `@sylphlab/typeql-core`: Core library containing server/client creation logic, types, and delta utilities.
*   `@sylphlab/typeql-react`: React hooks (`useQuery`, `useMutation`, `useSubscription`).
*   `@sylphlab/typeql-preact`: Preact hooks.
*   `@sylphlab/typeql-transport-websocket`: WebSocket transport adapter.
*   `@sylphlab/typeql-transport-http`: HTTP transport adapter (supports batching).
*   `@sylphlab/typeql-transport-vscode`: VSCode extension transport adapter.

---

## 🛠️ Development

This is a monorepo managed with `bun` and potentially Turborepo/Changesets.

1.  **Install:** `bun install`
2.  **Build:** `bun run build` (TODO: Implement root build)
3.  **Test:** `bun run test`

---

## Contributing

Contributions welcome! Please open an issue or PR.

---

## License

MIT