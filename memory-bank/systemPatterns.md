# System Patterns for ReqDelta

*   **Core Pattern**: Request/Response for initial state, Publish/Subscribe for incremental updates, leveraging Functional Programming principles (pure functions, immutable data, composition).
*   **Transport Abstraction**:
    *   Core library defines a minimal `Transport` interface.
    *   Specific transport implementations (WebSocket, postMessage, HTTP, etc.) are provided as separate npm packages (e.g., `reqdelta-transport-websocket`).
    *   Users can provide their own custom `Transport` implementations.
*   **Core Transport Interface**:
    ```typescript
    export interface Transport {
      sendMessage(payload: any): Promise<void> | void;
      onMessage(callback: (payload: any) => void): (() => void) | void; // Returns an optional cleanup function
    }
    ```
*   **Message Structure**: Standardized message types defined in `@reqdelta/core` (`packages/core/src/core/types.ts`). Includes `request`, `response`, `subscribe`, `unsubscribe`, `update` with fields like `type`, `id`, `topic`, `payload`, `error`, `delta`.
*   **State Management (Client)**: Client-side store (`createStore` factory function in `@reqdelta/core`) built using functional composition (higher-order functions/enhancers like `withTransport`, `withDeltaHandling`, `withOptimisticUpdates`). Core manages immutable state. Integration adapters planned.
*   **Subscription Management (Server)**: Server-side manager (`SubscriptionManager` in `@reqdelta/core`) tracks client subscriptions per topic and dispatches updates. Designed functionally.
*   **Delta Strategies**:
    *   Provides standard delta types (`StandardDelta`) and a pure function `applyStandardDelta` within `@reqdelta/core`.
    *   Supports custom application-specific deltas and application logic via function parameters.
    *   JSON Patch support planned.
*   **Type Safety**: Leverage TypeScript generics and direct type usage (no separate schema language) within `@reqdelta/core` for end-to-end type safety.
*   **Optimistic Updates Pattern (Functional)**:
    *   Implemented via a higher-order function/enhancer (`withOptimisticUpdates`).
    *   Maintains immutable `confirmedState` and derives `optimisticState` by applying pending operations.
    *   **Snapshotting**: State snapshots can be captured conceptually before applying optimistic deltas (though the functional approach might manage this via closures or state history).
    *   **Pending Queue**: Store pending operations (with relevant info like `clientSeq`, original operation, potentially `operationToDelta` function) internally.
    *   **Rollback/Rebase**: On server rejection or conflicting server update, recalculate `optimisticState` from `confirmedState` and remaining pending operations.
    *   **Confirmation**: When server confirms (`ack`), update `confirmedState` using `applyDelta` and remove the operation from the pending queue.
*   **Sequence ID Management**:
    *   **Client**: Maintains a monotonically increasing `clientSeq` for optimistic updates sent to the server.
    *   **Server**: Maintains a globally (or per-topic) monotonically increasing `serverSeq` assigned to successfully processed and ordered updates.
    *   **Messages**: Client optimistic updates include `clientSeq`. Server `ack` messages include `clientSeq` (for correlation) and `serverSeq`. Server `update` messages include `serverSeq` and `prevServerSeq`.
*   **Conflict Resolution**:
    *   **Detection**: Conflicts detected based on server logic (e.g., state mismatch, business rules) upon receiving a client's optimistic update. Also detected by client if `serverSeq` gap occurs.
    *   **Strategies**: Configurable resolution (e.g., client-wins, server-wins, last-write-wins based on timestamp, custom function). Interface defined in `@reqdelta/core`. Default strategy TBD (likely server-wins or error).
*   **Data Consistency & Recovery**:
    *   **Gap Detection**: Client detects missing updates by comparing incoming `update.prevServerSeq` with its last known `serverSeq`.
    *   **Recovery Request**: Client sends a specific message requesting updates within a `serverSeq` range.
    *   **Server History**: Server maintains a configurable buffer (`UpdateHistory`) of recent `update` messages to serve recovery requests.
