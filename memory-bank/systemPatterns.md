# System Patterns for ReqDelta

*   **Core Pattern**: Request/Response for initial state, Publish/Subscribe for incremental updates.
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
*   **State Management (Client)**: Client-side store (`createStore` in `@reqdelta/core`) manages state, loading, errors, and applies deltas. Integration adapters (planned for `@reqdelta/core` or separate packages) for external stores (Nanostores, Redux).
*   **Subscription Management (Server)**: Server-side manager (`SubscriptionManager` in `@reqdelta/core`) tracks client subscriptions per topic and dispatches updates.
*   **Delta Strategies**: Support within `@reqdelta/core` for both custom application-specific deltas and standardized JSON Patch (RFC 6902).
*   **Type Safety**: Leverage TypeScript generics within `@reqdelta/core` for end-to-end type safety.
*   **Optimistic Updates Pattern**:
    *   **Dual State (Client)**: Maintain `confirmedState` (server-acknowledged) and `optimisticState` (includes local, unconfirmed updates).
    *   **Snapshotting**: Before applying an optimistic update locally, snapshot the current `optimisticState`.
    *   **Pending Queue**: Store optimistic updates (with their delta and snapshot) in a queue, keyed by `clientSeq`.
    *   **Rollback**: If server rejects an update (`ack` message with `success: false`), revert `optimisticState` to the corresponding snapshot and remove the update from the pending queue. Re-apply subsequent pending updates onto the reverted state.
    *   **Confirmation**: If server confirms (`ack` message with `success: true`), apply the delta to `confirmedState` and remove from the pending queue.
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
