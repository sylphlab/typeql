# System Patterns for ReqDelta (tRPC-Inspired)

*   **Core Pattern**: End-to-end typesafe API leveraging TypeScript inference, inspired by tRPC. Focus on Queries, Mutations, and **Incremental Delta Subscriptions**.
*   **Server Architecture (`@reqdelta/server`)**:
    *   **Routers**: Define API structure using nested routers (`createRouter`).
    *   **Procedures**: Define endpoints within routers as `query`, `mutation`, or `subscription` procedures.
        *   Procedures are TypeScript functions acting as resolvers.
        *   Input types inferred or validated (e.g., using Zod).
        *   Output types inferred from return values.
    *   **`query`**: Returns data snapshot.
    *   **`mutation`**: Executes action, returns result. Can trigger backend processes that generate deltas.
    *   **`subscription`**: Returns an observable/async iterator that yields an *initial state* (optional) followed by a stream of *incremental delta updates*. Server logic connects backend change events to delta generation.
    *   **Context**: Procedures receive request context (e.g., user info).
    *   **AppRouter Type Export**: The final merged router's *type* (`AppRouter = typeof appRouter;`) is exported for the client.
    *   **Request Handler**: `createRequestHandler` binds a router to a specific client transport. It returns an object with `handleMessage` (to process incoming calls) and `cleanup` (to remove all associated subscriptions).
*   **Client Architecture (`@reqdelta/client`)**:
    *   **Client Proxy**: Created using `createClient<AppRouter>({...})`, importing only the *type* of the server's AppRouter.
    *   **Typed Proxy Object**: Provides a fully typed object mirroring the server router structure (e.g., `client.todos.list.query()`, `client.todos.add.mutate(...)`, `client.todos.onUpdate.subscribe(...)`).
    *   **`query` Call**: Fetches data via transport.
    *   **`mutate` Call**: Executes mutation via transport. Supports `optimisticUpdate` option for local state modification.
    *   **`subscribe` Call**: Initiates subscription via transport. Returns an object providing access to potential initial data and an observable/async iterator for the **delta stream**.
    *   **State Management / Delta Application**: Client needs mechanisms (e.g., hooks like `useReqDeltaSubscription`, helper functions) to manage local state (`confirmedState`, `optimisticState`) and apply incoming deltas using `applyDelta`. Optimistic updates are reconciled automatically when corresponding deltas arrive.
*   **Transport Abstraction**:
    *   Core library defines `TypeQLTransport` interface.
    *   Transport interface includes `request`, `subscribe`, optional `send`, `onAckReceived`, `requestMissingDeltas`, and optional `onDisconnect` for cleanup registration.
    *   Separate transport packages (`@reqdelta/transport-*`) implement specific protocols (WebSocket preferred for subscriptions).
    *   Handles message serialization/deserialization and routing procedure calls.
*   **Type Safety**: Relies entirely on TypeScript inference from the server router definition. No code generation needed.
*   **Delta Strategy**:
    *   Core provides `StandardDelta` types and `applyStandardDelta` helper.
    *   Server procedures are responsible for generating appropriate deltas based on backend changes.
    *   Client uses `applyDelta` (default or custom) to merge deltas into local state.
*   **Optimistic Updates**:
    *   Client calls `mutate` with an `optimisticUpdate` function.
    *   This function calculates and applies a *predicted delta* locally.
    *   Server processes mutation, generates actual delta(s), pushes via subscription.
    *   Client receives actual delta(s), applies them via `applyDelta`, automatically reconciling/overwriting the optimistic state. Conflict resolution logic needed if optimistic prediction differs significantly from server outcome (TBD).
*   **Data Consistency (Subscriptions)**:
    *   Delta messages include `serverSeq` and `prevServerSeq`.
    *   Client detects gaps and requests missing deltas via a dedicated mechanism/procedure call.
    *   Server maintains history buffer to serve missing deltas.
*   **Error Handling**:
    *   **Transport/Procedure Errors**: Errors during `query`/`mutate` calls or initial `subscribe` are caught by client hooks (`useQuery`, `useMutation`, `useSubscription`) and reflected in their state (`error`, `isError`, `status`). `useMutation` and `useSubscription` also call their `onError` option callbacks.
    *   **Store Listener Errors**: Errors within hook listeners (e.g., `select` in `useQuery`, `applyServerDelta` in `useSubscription`) are caught; `useSubscription` sets its error state and calls its `onError` option, while `useQuery` sets its error state if `select` fails.
    *   **Store Internal Errors**: Asynchronous errors within `OptimisticStore` (timeouts, conflicts, etc.) are propagated via the `onError` callback configured during store creation.
    *   **Centralized Handling**: The `TypeQLProvider` (React/Preact) can optionally create the `OptimisticStore` using `storeOptions`. If it does, it accepts an `onStoreError` prop and configures the store's `onError` to call this prop, allowing centralized handling of store-internal errors at the provider level.
