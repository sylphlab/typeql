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
*   **Client Architecture (`@reqdelta/client`)**:
    *   **Client Proxy**: Created using `createClient<AppRouter>({...})`, importing only the *type* of the server's AppRouter.
    *   **Typed Proxy Object**: Provides a fully typed object mirroring the server router structure (e.g., `client.todos.list.query()`, `client.todos.add.mutate(...)`, `client.todos.onUpdate.subscribe(...)`).
    *   **`query` Call**: Fetches data via transport.
    *   **`mutate` Call**: Executes mutation via transport. Supports `optimisticUpdate` option for local state modification.
    *   **`subscribe` Call**: Initiates subscription via transport. Returns an object providing access to potential initial data and an observable/async iterator for the **delta stream**.
    *   **State Management / Delta Application**: Client needs mechanisms (e.g., hooks like `useReqDeltaSubscription`, helper functions) to manage local state (`confirmedState`, `optimisticState`) and apply incoming deltas using `applyDelta`. Optimistic updates are reconciled automatically when corresponding deltas arrive.
*   **Transport Abstraction**:
    *   Core library defines `Transport` interface or similar link concept.
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
