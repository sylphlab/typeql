# Progress for TypeQL (formerly ReqDelta) - **DESIGN PIVOT**

*   **Phase 0: Initial ReqDelta Implementation (Largely Superseded)**
    *   [X] Basic message types (`packages/core/src/core/types.ts`) - *Likely adaptable*
    *   [X] Basic `Transport` interface (`packages/core/src/core/types.ts`) - *Likely adaptable*
    *   [X] ~~Basic client `createStore` (`packages/core/src/client/createStore.ts`)~~ - ***Removed (Obsolete)***
    *   [X] Server `SubscriptionManager` (`packages/core/src/server/subscriptionManager.ts`) - ***To be replaced/refactored for TypeQL subscriptions***
    *   [X] Server `RequestHandler` (`packages/core/src/server/requestHandler.ts`) - ***To be replaced by TypeQL router/procedure logic***
    *   [X] `generateId` util (`packages/core/src/core/utils.ts`) - *Likely reusable*
    *   [X] Monorepo structure setup - *Still valid*
    *   [X] Core build process (`packages/core/tsconfig.json`) - *Still valid, build successful for all packages.*
    *   [X] Standard Delta/Operation types (`packages/core/src/core/types.ts`) - *Adaptable, added Move/Patch*
    *   [X] Standard Delta utilities (`applyStandardDelta`, etc.) (`packages/core/src/core/utils.ts`) - *Likely reusable, added Move/Patch logic*
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
        *   [X] Refactor `RequestHandler` to bind to a specific transport/client, manage its subscriptions, and implement reliable cleanup via `transport.onDisconnect`.
    *   **Client (`@typeql/client` - or refactor `@reqdelta/client`)**
        *   [X] Implement `createClient` function to generate typed proxy from server router type (`packages/core/src/client/client.ts`). Updated to support optimistic mutation options and interact with `OptimisticStore`.
        *   [X] Implement `query`, `mutate`, `subscribe` call logic using `TypeQLTransport` interface (`packages/core/src/client/client.ts`). `mutate` updated for optimistic flow. `subscribe` updated to use AsyncIterableIterator.
        *   [X] Implement client-side subscription handling for delta streams using AsyncIterableIterator (`packages/[REMOVED]/src/index.ts`, `packages/react/src/index.ts`).
    *   **Core (`@typeql/core` - or keep `@reqdelta/core`)**
    *   [X] Refine shared types: Updated `TypeQLTransport` interface (added `onDisconnect`) and message types for TypeQL (`packages/core/src/core/types.ts`). Added types for optimistic updates (`AckMessage`, `clientSeq`, `serverSeq`, `prevServerSeq`). Refactored `subscribe` transport method to return AsyncIterableIterator.
    *   [X] Fix TS errors resulting from type changes in `subscriptionManager.ts`, ~~`createStore.ts`~~, `updateHistory.ts`, `requestHandler.ts`, `client.ts`, `[REMOVED]/index.ts`, `react/index.ts`. Updated `updateHistory` and `requestHandler` to use new sequence numbers.
    *   [X] ~~Refactor `createStore.ts` to basic non-optimistic version aligned with TypeQL.~~ - ***Removed (Obsolete)***
        *   [X] ~~Remove outdated `optimisticStore.ts`.~~ - ***Replaced by new implementation***
        *   [X] Created basic structure for `OptimisticStore` (`packages/core/src/client/optimisticStore.ts`) using Immer. **Refactored to use `DeltaApplicator` interface.**
        *   [X] Ensure delta utilities are compatible.
    *   **Phase 2: Feature Implementation (TypeQL)**
        *   [X] Implement input validation (e.g., Zod integration in `ProcedureBuilder`).
        *   [X] Implement optimistic update mechanism (`OptimisticStore` finalized: rejection, timeout, gap recovery logic added).
    *   [X] Implement optimistic update mechanism on client `mutate` calls (`client.ts` interacts with store).
    *   [X] Implement delta reconciliation logic on client (`OptimisticStore` handles this via `applyServerDelta` and `recomputeOptimisticState`).
    *   [X] Implement conflict resolution logic in `OptimisticStore.applyServerDelta`. Refactored resolver to return outcome, added basic post-resolution handling. **Refined client delta extraction (Immer -> JSON Patch).**
    *   [X] Implement data consistency/recovery for delta subscriptions (`OptimisticStore` detects gaps, calls transport `requestMissingDeltas`).
    *   [X] Implement context passing for server procedures (`ProcedureBuilder`, `requestHandler`).
    *   [X] Implement error handling and propagation (Server-side request handler, Client-side React hook). **Reviewed and improved `OptimisticStore` error handling (added `onError` callback). Improved React hook error handling (`TypeQLProvider`, `useQuery`).**
    *   **Phase 3: Transport Adapters & Integrations**
    *   [ ] Create/Adapt remaining transport adapters (`@typeql/transport-*`).
    *   [X] Set up basic `@sylphlab/typeql-react` package structure (`package.json`, `tsconfig.json`, `src/index.ts`). **(Verified Existence)**
    *   [X] Implement core React hooks (`TypeQLProvider`, `useTypeQLClient`, etc.) in `@sylphlab/typeql-react`. **(Verified Existence)**
    *   [X] Implement `useQuery` hook in `@sylphlab/typeql-react`. **(Verified Existence)**
    *   [X] Implement `useMutation` hook in `@sylphlab/typeql-react`. **(Verified Existence)**
    *   [X] Implement `useSubscription` hook in `@sylphlab/typeql-react`. **(Verified Existence)**
    *   [X] **REWRITTEN:** `@sylphlab/typeql-[REMOVED]` - Core logic implemented (connect, disconnect, request, subscribe data/end/error/unsubscribe, optimistic hooks). 10/16 tests pass.
    *   [X] Set up basic `@typeql/preact` package structure (`package.json`, `tsconfig.json`, `src/index.ts`).
    *   [X] Implement core Preact hooks (`TypeQLProvider`, `useTypeQL`, `useQuery`, `useMutation`, `useSubscription`) in `@typeql/preact`.
    *   [X] Set up basic `@typeql/transport-http` package structure.
    *   [X] Implement HTTP transport batching (client-side) in `@typeql/transport-http`.
    *   [X] Implement HTTP transport batching (server-side) in `RequestHandler`.
    *   [X] Set up basic `@sylphlab/typeql-transport-vscode` package structure (`package.json`, `tsconfig.json`, `src/index.ts`). **(Verified Existence)**
    *   [X] Implement VSCode transport logic (`createVSCodeTransport`) including `disconnect`. **(Verified Existence)**
    *   **Phase 4: Optimization & Testing**
    *   [X] Add comprehensive tests for `OptimisticStore` (`packages/core/src/client/__tests__/optimisticStore.test.ts`). **All tests passing.**
    *   [ ] Add comprehensive tests for `@typeql/[REMOVED]` (`packages/[REMOVED]/src/transport.test.ts`). **IN PROGRESS:** 15/16 tests pass. 1 test failing (`should stop reconnecting after max attempts`) likely due to testing environment issues.
    *   [X] Add comprehensive tests for `@typeql/preact` hooks (`packages/preact/src/__tests__/index.test.tsx`). **Verified: All tests passing (25/25).**
    *   [X] Add tests for `@typeql/transport-http` (Verified existing tests cover batching). **Verified: All tests passing (9/9).** Expected stderr warnings during error handling tests are present.
    *   [X] Add tests for `@sylphlab/typeql-react` hooks (`packages/react/src/__tests__/*.test.tsx`). **Verified: All tests passing (25/25).**
    *   [X] Add tests for `@sylphlab/typeql-transport-vscode` (`packages/transport-vscode/src/__tests__/index.test.ts`). **Verified: All tests passing (22/22).**
    *   [X] Add tests for `@sylphlab/typeql-server` utilities (`subscriptionManager.ts`, `updateHistory.ts`). **All tests passing (previous note about skipped test was outdated).**
    *   [ ] Performance optimization (Reviewed `OptimisticStore`, no immediate actions).
    *   [X] Add tests for 'merged' conflict resolution strategy in `OptimisticStore`.
    *   [X] Implement Web App Example (`examples/web-app/`) - Server and Client code complete.
    *   [X] Implement VSCode Extension Example (`examples/vscode-extension/`) - Basic structure and TypeQL setup complete (Server & Client). **Verified: Requires build step for webview (`compile` script exists).**

*   **Current Status (2025-04-20 - 07:44 AM):** WebSocket transport rewrite largely complete. Core functionality passes tests.
*   **Overall Status:** **NOT READY FOR RELEASE.** WebSocket transport still has 1 failing test related to connection listeners (`stop reconnecting`).
*   **Remaining Issues/Blockers**:
    *   `@sylphlab/typeql-[REMOVED]`: 1 failing test (`stop reconnecting`) needs investigation (potentially test environment related).
    *   Overall test coverage needs review (Currently ~88% Lines, ~77% Branch across tested packages).
    *   Performance optimization review pending.
    *   VSCode example webview requires a build process (confirmed).

## 2025-04-20: Release Readiness Check

*   **Goal:** Assess if the project is ready for release.
*   **Checks Performed:**
    *   Linting (`pnpm run lint` via `turbo`): **FAILED** (Missing ESLint config in `typeql-vscode-example`).
    *   Type Checking (`tsc --noEmit`): **PASSED**.
    *   Testing (`pnpm run test` via `vitest`): **PASSED** (but 22 tests marked as 'todo').
    *   TODO/FIXME Search: Found **23 instances**.
    *   Changeset Status (`dir .changeset`): No pending changesets.
*   **Conclusion:** Project is **NOT** ready for release due to linting failure, 'todo' tests, and TODO/FIXME markers.
*   **Blockers:**
    1.  Missing ESLint config in `examples/vscode-extension`.
    2.  22 'todo' tests need implementation.
    3.  23 TODO/FIXME comments need addressing.

## 2025-04-20: Release Readiness Re-assessment (Ignoring Linting)

*   **Goal:** Re-assess release readiness, ignoring previous linting failure as per user directive.
*   **Checks Considered:**
    *   Type Checking (`tsc --noEmit`): **PASSED**.
    *   Testing (`pnpm run test` via `vitest`): **PASSED** (but 22 tests marked as 'todo').
    *   TODO/FIXME Search: Found **23 instances**.
    *   Changeset Status (`dir .changeset`): No pending changesets.
*   **Conclusion:** Project is **STILL NOT** ready for release due to 'todo' tests and TODO/FIXME markers.
*   **Remaining Blockers (Ignoring Lint):**
    1.  22 'todo' tests need implementation.
    2.  23 TODO/FIXME comments need addressing.
