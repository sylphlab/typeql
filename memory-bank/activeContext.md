# Active Context for ReqDelta

*   **Current Focus**: **PIVOTING DESIGN** towards a tRPC-inspired architecture focusing on end-to-end type safety and incremental delta subscriptions. Updating Memory Bank.
*   **Recent Changes**:
    *   MAJOR DESIGN SHIFT: Decided to adopt a tRPC-like code-first approach based on user feedback.
    *   Updated `projectbrief.md` with the new core concept and features.
    *   Updated `systemPatterns.md` with the new tRPC-inspired architecture (routers, procedures, client proxy, delta subscriptions).
*   **Next Steps**:
    *   Update `progress.md` to reflect the significant refactoring required by the design pivot.
    *   Update this file (`activeContext.md`) with the new direction and next implementation steps.
    *   Commit all Memory Bank changes reflecting the TypeQL pivot.
    *   Created placeholder files for TypeQL server logic: `packages/core/src/server/router.ts` and `packages/core/src/server/procedure.ts`. Refactored `procedure.ts` to fix TS errors and improve builder structure.
*   **Next Steps**:
    *   Refined and confirmed the core implementation of `ProcedureBuilder` in `packages/core/src/server/procedure.ts`. Generic type propagation is working as intended.
    *   Integrated Zod for input/output/subscriptionOutput validation/parsing in `ProcedureBuilder` (`packages/core/src/server/procedure.ts`). Types are now inferred from Zod schemas.
    *   Implemented initial `createRouter` function and `Router` class structure in `packages/core/src/server/router.ts`.
    *   Implemented initial request handler logic in `packages/core/src/server/requestHandler.ts` (`createRequestHandler`).
    *   Implemented initial client proxy structure in `packages/core/src/client/client.ts` (`createClient`).
    *   Updated `Transport` interface and related message types in `packages/core/src/core/types.ts` to align better with TypeQL (request/result, subscription lifecycle).
    *   Fixed resulting TypeScript errors in `subscriptionManager.ts`, `optimisticStore.ts`, `createStore.ts`, and `updateHistory.ts` after TypeQL type refactoring. (Note: `optimisticStore.ts` and `createStore.ts` still require significant logic refactoring).
    *   Integrated the `TypeQLTransport` interface into the client proxy (`packages/core/src/client/client.ts`).
    *   Refined `SubscriptionManager` to focus on lifecycle/cleanup and removed direct transport dependency.
    *   Updated `createRequestHandler` to handle subscription setup using `SubscriptionManager` and defined a `publish` function that assumes the `transport` context object has a method for server-to-client messaging (e.g., `sendMessage`). Fixed related TS errors.
    *   Update `progress.md` reflecting these server-side integration refinements.
    *   Commit changes.
    *   Next major step: Define a concrete transport implementation (e.g., WebSocket) or start designing client-side state management helpers (e.g., React hooks) that utilize the client proxy. Need to clarify how `clientId` is determined and passed server-side.
*   **Active Decisions**:
    *   **PIVOT**: Adopt tRPC-inspired architecture (code-first, inferred types, routers/procedures) while retaining the core focus on **incremental delta updates** for subscriptions.
    *   GraphQL approach rejected due to preference against GQL syntax and schema definition.
    *   Previous FP-focused implementation (`createStore`, `RequestHandler`) will be heavily refactored or replaced to fit the new model.
    *   Project remains an npm workspace monorepo.
    *   Transports remain separate packages.
    *   Core library `@reqdelta/core` will contain shared types, delta utilities.
    *   `@reqdelta/server` will contain router/procedure logic.
    *   `@reqdelta/client` will contain client proxy creation and state management helpers.
    *   All documentation (Memory Bank, comments) will be in English.
*   **Blockers**: None, but significant refactoring required.
