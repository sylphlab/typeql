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
    *   Update `progress.md` and `techContext.md` reflecting Zod integration.
    *   Commit changes.
    *   Next major step: Begin implementing the router logic (`packages/core/src/server/router.ts`) to consume these procedures and handle basic request routing.
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
