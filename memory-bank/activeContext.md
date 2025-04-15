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
    *   Fixed resulting TypeScript errors in `subscriptionManager.ts`, `optimisticStore.ts`, `createStore.ts`, and `updateHistory.ts` after TypeQL type refactoring.
    *   Integrated the `TypeQLTransport` interface into the client proxy (`packages/core/src/client/client.ts`).
    *   Refined `SubscriptionManager` and `createRequestHandler`.
    *   Set up the `@typeql/react` package and resolved initial build/dependency issues.
    *   Implemented basic React Context (`TypeQLContext`), `TypeQLProvider`, and `useTypeQLClient` hook in `@typeql/react/src/index.ts`.
    *   Implemented basic `useQuery` hook in `@typeql/react/src/index.ts`.
    *   Implemented basic `useMutation` hook in `@typeql/react/src/index.ts`.
    *   Implemented basic `useSubscription` hook in `@typeql/react/src/index.ts`.
    *   Set up the `@typeql/transport-websocket` package and implemented basic transport logic.
    *   Refactored `packages/core/src/client/createStore.ts` into a basic, non-optimistic store aligned with TypeQL architecture.
    *   Removed `packages/core/src/client/optimisticStore.ts` as its logic was incompatible and needs complete redesign for TypeQL's model. Optimistic updates will be a separate future feature.
    *   Update `progress.md` reflecting store refactoring and removal.
    *   Commit changes.
    *   Refined React hooks (`useQuery`, `useMutation`, `useSubscription`) in `@typeql/react` with TSDoc, placeholder options, and consistent error handling.
    *   Updated core types (`types.ts`) for optimistic updates (`clientSeq`, `serverSeq`, `prevServerSeq`, `AckMessage`).
    *   Updated server logic (`updateHistory.ts`, `requestHandler.ts`) to use new sequence numbers.
    *   Created basic structure for `OptimisticStore` (`optimisticStore.ts`) using Immer, including listener support.
    *   Updated client proxy (`client.ts`) to support optimistic options in `mutate` and interact with the store. Added documentation note about wiring transport callback.
    *   Updated WebSocket transport (`transport-websocket/index.ts`) to handle `AckMessage` via `onAckReceived` callback.
    *   Updated React hooks (`react/index.ts`) context/provider to include optional store, integrated `useMutation` hook with store logic via options.
    *   Next major step: Finish integrating `OptimisticStore`. This involves:
        *   [X] Client Creation Wiring: Automatically wire `transport.onAckReceived` to `store.confirmPendingMutation` in `createClient` (`client.ts`). Removed related warning/documentation note.
        *   [X] Store TODOs Implemented:
            *   [X] Rejection Handling: Added `rejectPendingMutation` method to store interface and implementation (`optimisticStore.ts`). Clear timers on rejection.
            *   [X] Gap Recovery: Added `requestMissingDeltas` to `TypeQLTransport` interface (`types.ts`). Implemented it in WebSocket transport (`transport-websocket/src/index.ts`) to send `request_missing` message. Updated `applyServerDelta` in store to call the `requestMissingDeltas` option (`optimisticStore.ts`).
            *   [X] Timeout Logic: Implemented timeout setting in `addPendingMutation` and clearing in `confirmPendingMutation`/`rejectPendingMutation`/pruning (`optimisticStore.ts`).
        *   [X] React Hooks Integration:
            *   [X] `useSubscription`: Modified `onData` to call `store.applyServerDelta` if store exists (`react/src/index.ts`).
            *   [X] `useQuery`: Subscribes to store updates via `store.subscribe` and updates local data state with `store.getOptimisticState` (`react/src/index.ts`).
*   **Current Focus**: Completed optimistic update feature integration. Next: Update progress and commit.
*   **Future Priorities (Post-Optimistic Updates)**:
    1.  Implement Preact transport (`@typeql/transport-preact` - TBC name).
    2.  Implement VSCode transport (`@typeql/transport-vscode` - TBC name).
*   **Optimistic Updates Design Outline (Completed in this session)**:
    1.  **State Management**:
        *   [X] New/Enhanced Store structure created (`OptimisticStore` in `optimisticStore.ts`).
        *   [X] Manages `confirmedState` and `optimisticState`.
        *   [X] Requires `clientSeq` generation (`clientSeqManager`) and tracking (`pendingMutations` array).
        *   [X] Basic rollback/recompute logic implemented (`recomputeOptimisticState`). Needs refinement for rejections.
        *   [X] Listener mechanism added (`subscribe`, `notifyListeners`).
    2.  **`useMutation` Hook (`@typeql/react`)**:
        *   [X] `optimistic.predictedChange` option added to `UseMutationOptions`.
        *   [X] Hook gets store instance from context (`useTypeQL`).
        *   [X] Hook passes `optimistic` config from options to client proxy's `mutate` call.
        *   [X] Client proxy (`client.ts`) uses `optimistic.predictedChange` to call `store.addPendingMutation`.
        *   [ ] Store's listener mechanism needs to be used by hooks (`useQuery`, potentially others) to reflect state changes.
    3.  **Core Types (`@typeql/core`)**:
        *   [X] Extended `ProcedureCallMessage` with `clientSeq`.
        *   [X] Defined `AckMessage`.
        *   [X] Updated `SubscriptionDataMessage` with `serverSeq`, `prevServerSeq`.
    4.  **Delta Application (`OptimisticStore`)**:
        *   [X] Basic delta application logic (`applyServerDelta`) handles `serverSeq`.
        *   [X] Basic sequence gap detection implemented.
        *   [X] Missing Delta Request: `requestMissingDeltas` added to transport options/interface, called by store.
        *   [X] Reconciliation via `recomputeOptimisticState` confirmed.
        *   [X] Rejection Handling: `rejectPendingMutation` added and called on timeout/error.
        *   [X] Timeout Logic: Implemented via `setTimeout`/`clearTimeout`.
    5.  **Transport Layer (`transport-websocket`)**:
        *   [X] `clientSeq` sent by client proxy.
        *   [X] `onAckReceived` callback added to options and called in `handleMessage`.
        *   [X] Client creation automatically wires `store.confirmPendingMutation` to `transport.onAckReceived`. Doc note removed.
        *   [X] `requestMissingDeltas` implemented to send `request_missing` message.
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
