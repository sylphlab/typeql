# Progress for TypeQL (formerly ReqDelta) - **DESIGN PIVOT**

*   **Phase 0: Initial ReqDelta Implementation (Largely Superseded)**
    *   [X] Basic message types (`packages/core/src/core/types.ts`) - *Likely adaptable*
    *   [X] Basic `Transport` interface (`packages/core/src/core/types.ts`) - *Likely adaptable*
    *   [X] Basic client `createStore` (`packages/core/src/client/createStore.ts`) - ***To be replaced by TypeQL client logic***
    *   [X] Server `SubscriptionManager` (`packages/core/src/server/subscriptionManager.ts`) - ***To be replaced/refactored for TypeQL subscriptions***
    *   [X] Server `RequestHandler` (`packages/core/src/server/requestHandler.ts`) - ***To be replaced by TypeQL router/procedure logic***
    *   [X] `generateId` util (`packages/core/src/core/utils.ts`) - *Likely reusable*
    *   [X] Monorepo structure setup - *Still valid*
    *   [X] Core build process (`packages/core/tsconfig.json`) - *Still valid*
    *   [X] Standard Delta/Operation types (`packages/core/src/core/types.ts`) - *Adaptable*
    *   [X] Standard Delta utilities (`applyStandardDelta`, etc.) (`packages/core/src/core/utils.ts`) - *Likely reusable*
    *   [X] Sequence number management (`packages/core/src/core/seqManager.ts`) - *Adaptable for delta subscriptions*
    *   [X] Server-side update history (`packages/core/src/server/updateHistory.ts`) - *Adaptable for delta subscriptions*
*   **Phase 1: TypeQL Core Implementation**
    *   **Server (`@typeql/server` - or refactor `@reqdelta/server`)**
        *   [X] Define core router/procedure building blocks (`createRouter`, `query`, `mutation`, `subscription`) - *Placeholder files created and corrected (`router.ts`, `procedure.ts`)*
        *   [X] Implement core type inference mechanism for procedures (`packages/core/src/server/procedure.ts` - `ProcedureBuilder` refined).
        *   [X] Implement basic router structure (`packages/core/src/server/router.ts` - `createRouter`, `Router` class).
        *   [X] Implement basic request handling logic for Query/Mutation (`packages/core/src/server/requestHandler.ts` - `createRequestHandler`).
        *   [X] Refine subscription handling in `RequestHandler` (uses `SubscriptionManager`, defines `publish`).
        *   [X] Refactor `SubscriptionManager` to manage lifecycle/cleanup, remove direct transport dependency.
    *   **Client (`@typeql/client` - or refactor `@reqdelta/client`)**
        *   [X] Implement `createClient` function to generate typed proxy from server router type (`packages/core/src/client/client.ts`). Updated to support optimistic mutation options and interact with `OptimisticStore`.
        *   [X] Implement `query`, `mutate`, `subscribe` call logic using `TypeQLTransport` interface (`packages/core/src/client/client.ts`). `mutate` updated for optimistic flow.
        *   [ ] Implement client-side subscription handling for delta streams (needs actual transport implementation & observable/iterator return type).
    *   **Core (`@typeql/core` - or keep `@reqdelta/core`)**
        *   [X] Refine shared types: Updated `Transport` interface and message types for TypeQL (`packages/core/src/core/types.ts`). Added types for optimistic updates (`AckMessage`, `clientSeq`, `serverSeq`, `prevServerSeq`).
        *   [X] Fix TS errors resulting from type changes in `subscriptionManager.ts`, `createStore.ts`, `updateHistory.ts`, `requestHandler.ts`, `client.ts`. Updated `updateHistory` and `requestHandler` to use new sequence numbers.
        *   [X] Refactor `createStore.ts` to basic non-optimistic version aligned with TypeQL.
        *   [X] Remove outdated `optimisticStore.ts`.
        *   [X] Created basic structure for `OptimisticStore` (`packages/core/src/client/optimisticStore.ts`) using Immer.
        *   [ ] Ensure delta utilities are compatible.
*   **Phase 2: Feature Implementation (TypeQL)**
    *   [X] Implement input validation (e.g., Zod integration in `ProcedureBuilder`).
    *   [X] Implement optimistic update mechanism (`OptimisticStore` finalized: rejection, timeout, gap recovery logic added).
    *   [X] Implement optimistic update mechanism on client `mutate` calls (`client.ts` interacts with store).
    *   [X] Implement delta reconciliation logic on client (`OptimisticStore` handles this via `applyServerDelta` and `recomputeOptimisticState`).
    *   [X] Implement data consistency/recovery for delta subscriptions (`OptimisticStore` detects gaps, calls transport `requestMissingDeltas`).
    *   [ ] Implement context passing for server procedures.
    *   [ ] Implement error handling and propagation.
*   **Phase 3: Transport Adapters & Integrations**
    *   [ ] Create/Adapt transport adapters (`@typeql/transport-*`).
    *   [X] Set up basic `@typeql/react` package structure (`package.json`, `tsconfig.json`, `src/index.ts`). Resolved build/dependency issues using bun.
    *   [X] Implement core React hooks (`TypeQLProvider`, `useTypeQL`) in `@typeql/react`. Added `store` to context. Deprecated `useTypeQLClient`.
    *   [X] Implement `useQuery` hook in `@typeql/react`. (Refined, integrated with `useTypeQL`, **connected to OptimisticStore updates**).
    *   [X] Implement `useMutation` hook in `@typeql/react`. (Refined, integrated with `useTypeQL`, supports optimistic options).
    *   [X] Implement `useSubscription` hook in `@typeql/react`. (Refined, integrated with `useTypeQL`, **connected to OptimisticStore `applyServerDelta`**).
    *   [X] Set up basic `@typeql/transport-websocket` package structure.
    *   [X] Implement WebSocket transport logic (`createWebSocketTransport`) including connection, request/response correlation, subscription handling placeholders, reconnect logic, automatic resubscription, `onAckReceived` callback, and `requestMissingDeltas` method.
*   **Phase 4: Optimization & Testing**
    *   [ ] Add comprehensive tests for TypeQL architecture (especially optimistic updates).
    *   [ ] Performance optimization.

*   **Current Status**: **Design pivoted to TypeQL**. Memory Bank updated. Previous ReqDelta implementation largely needs replacement/heavy refactoring. Monorepo structure remains valid.
*   **Known Issues**: Entire implementation needs to be aligned with the new TypeQL design. Conflict resolution details TBD. Server needs a way to identify clients/transports for subscriptions. `createStore.ts` logic still relies on old ReqDelta patterns for state management within the TypeQL structure. **`useQuery` optimistic update integration assumes TState is compatible with TOutput - may need refinement.**
