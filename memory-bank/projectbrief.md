# ReqDelta: ReqRes + PubSub Incremental Update Library Design

## Core Concept
ReqDelta is a transport-agnostic TypeScript library designed to standardize the communication pattern for Request/Response initial state fetching and Publish/Subscribe incremental updates.

## Main Features
*   **Transport Agnostic**: Supports any communication protocol (WebSocket, postMessage, HTTP, etc.).
*   **Unified Message Types**: Standardizes message formats for requests, responses, subscriptions, and incremental updates.
*   **Type Safety**: Leverages TypeScript generics for end-to-end type safety.
*   **State Management Integration**: Designed for integration with popular state management libraries (e.g., Nanostores, Redux).
*   **Optimistic Updates**: Built-in support for client-side optimistic updates with rollback and conflict resolution.
*   **Conflict Resolution**: Manages concurrency conflicts using Sequence IDs and timestamps with configurable strategies.
*   **Data Consistency**: Includes mechanisms for detecting and recovering lost updates.

## System Architecture
1.  **Core Layer**
    *   Type Definitions: Defines common message types and interfaces.
    *   Abstract Transport Interface: Provides a pluggable communication layer.
    *   Common Utilities: Handles generic logic and functions.
2.  **Client Layer**
    *   Store Creator: Manages state, loading status, and error handling.
    *   Delta Processor: Applies incremental updates to the local state.
    *   Integration Adapters: Connects to popular state management libraries.
3.  **Server Layer**
    *   Subscription Manager: Manages client subscriptions and dispatches updates.
    *   Request Handler: Processes initial state requests.
    *   Delta Generator: Constructs and sends incremental updates.
4.  **Transport Adapters (Separate Packages)**
    *   Core library only defines the `Transport` interface.
    *   Specific adapters (e.g., WebSocket, VSCode postMessage, HTTP) will be provided as separate `reqdelta-transport-*` npm packages.

## Message Format
1.  **Request Initial State (Client → Server)**
    ```typescript
    {
      type: 'request',
      id: 'random-id',
      topic: 'topic-name',
      payload?: any // Optional payload
    }
    ```
2.  **Response Initial State (Server → Client)**
    ```typescript
    {
      type: 'response',
      id: 'request-id',
      topic: 'topic-name',
      payload: any,
      error?: string
    }
    ```
3.  **Subscribe to Updates (Client → Server)**
    ```typescript
    {
      type: 'subscribe',
      id: 'random-id',
      topic: 'topic-name'
    }
    ```
4.  **Unsubscribe from Updates (Client → Server)**
    ```typescript
    {
      type: 'unsubscribe',
      id: 'random-id',
      topic: 'topic-name'
    }
    ```
5.  **Incremental Update (Server → Client)**
    ```typescript
    {
      type: 'update',
      topic: 'topic-name',
      delta: any // Incremental update data
    }
    ```

## Delta Update Strategies
The library supports two main delta update strategies:
*   **Custom Delta Updates**: Application-specific delta types, e.g.:
    ```typescript
    type ChatDelta =
      | { type: 'add_message'; message: Message }
      | { type: 'edit_message'; id: string; text: string }
      | { type: 'delete_message'; id: string };
    ```
*   **JSON Patch (RFC 6902)**: Standard JSON modification format, suitable for general cases.

## Optimistic Updates & Conflict Resolution
*   **Core Mechanism**: Client maintains both a "confirmed state" and an "optimistic state". State is snapshotted before applying local updates to allow rollback on server rejection or conflict.
*   **Sequence IDs**: Client assigns `clientSeq` to local updates. Server assigns global `serverSeq` to successfully applied updates. Server confirms client updates via `ack` messages containing `serverSeq`.
*   **Message Extensions**: `update` messages include `serverSeq` and optional `prevServerSeq` (for detecting lost messages). New `ack` message type for server confirmation. New client message type for submitting optimistic updates. New message type for requesting missing updates.
*   **Conflict Handling**: Provides configurable strategies (e.g., client-wins, server-wins, custom) and interfaces to handle conflicts between optimistic updates and server updates.
*   **Recovery Mechanism**: Client can detect gaps in `serverSeq` and request missing updates. Server needs to maintain a history buffer of recent updates to fulfill recovery requests.

## Project Structure (Monorepo)
```
/
├── packages/
│   ├── core/                 # @reqdelta/core Core Library
│   │   ├── src/
│   │   │   ├── core/
│   │   │   │   ├── types.ts         # Core type definitions
│   │   │   │   └── utils.ts         # Common utility functions
│   │   │   ├── client/
│   │   │   │   ├── createStore.ts   # Client state management
│   │   │   │   └── index.ts
│   │   │   ├── server/
│   │   │   │   ├── subscriptionManager.ts # Subscription management
│   │   │   │   ├── requestHandler.ts       # Request handling
│   │   │   │   └── index.ts
│   │   │   ├── deltas/
│   │   │   │   ├── jsonPatch.ts      # JSON Patch support
│   │   │   │   ├── customDelta.ts    # Custom delta format
│   │   │   │   └── index.ts
│   │   │   └── integrations/         # Integrations with other libraries
│   │   │       ├── nanostores.ts
│   │   │       ├── redux.ts
│   │   │       └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── transport-websocket/  # @reqdelta/transport-websocket (Example)
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── ...                   # Other transport or integration packages
├── examples/
│   ├── vscode-extension/     # VSCode Extension Example
│   └── web-app/              # Web App Example
├── package.json              # Monorepo root package.json (defines workspace)
└── tsconfig.base.json        # (Optional) Base tsconfig
```

## Workflow
**Client Initialization Flow**
1.  Create a transport adapter instance.
2.  Create a store with initial state using `createStore`.
3.  Automatically request initial state.
4.  Automatically subscribe to incremental updates.

**Server Initialization Flow**
1.  Create a transport adapter instance.
2.  Initialize the subscription manager and request handler.
3.  Register the request handler to respond to initial state requests.
4.  Listen for client connections and subscription requests.

**Incremental Update Flow**
1.  Server detects data change.
2.  Server creates an incremental update object (delta).
3.  Server uses the subscription manager to send the update to relevant subscribed clients.
4.  Client receives and applies the delta to its local state.
5.  Client notifies its subscribers that the state has updated.

## Development Roadmap
**Phase 1: Core Functionality (@reqdelta/core)**
*   Implement basic message types and Transport interface.
*   Implement basic client `createStore` (without optimistic updates initially).
*   Implement server `SubscriptionManager` and `RequestHandler`.

**Phase 2: Optimistic Updates & Consistency (@reqdelta/core)**
*   Extend message types for sequence IDs, acks, etc.
*   Implement `OptimisticStore` on the client with snapshotting, rollback, and pending queue.
*   Implement sequence number management (`seqManager`).
*   Implement server-side update history (`updateHistory`).
*   Implement conflict resolution strategies and interfaces.
*   Implement update recovery mechanism (missing update requests).

**Phase 3: Enhancements & Integrations (@reqdelta/core)**
*   Add JSON Patch support.
*   Add integrations for popular state management libraries (Nanostores, Redux).
*   Improve error handling and reconnection logic.

**Phase 4: Transport Adapters & Optimization**
*   Create separate transport adapter packages (`@reqdelta/transport-*`).
*   Implement batch updates and update compression.
*   Performance optimization and comprehensive testing.

## Installation and Usage (Example)
```bash
# Install the core library and a specific transport
npm install @reqdelta/core @reqdelta/transport-websocket
```

This design provides a flexible, strongly-typed, and transport-agnostic solution for ReqRes + PubSub incremental update patterns across various scenarios, enhancing the efficiency and consistency of client-server communication, including support for optimistic updates and conflict resolution.
