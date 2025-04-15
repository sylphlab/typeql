# ReqDelta: ReqRes + PubSub 增量更新庫設計方案

## 核心概念
ReqDelta 是一個傳輸層無關的 TypeScript 庫，旨在標準化 Request/Response 初始狀態請求與 Publish/Subscribe 增量更新的通信模式。

## 主要特點
*   傳輸層無關：支持任何通信協議（WebSocket、postMessage、HTTP 等）
*   統一的消息類型：標準化請求、回應、訂閱和增量更新的消息格式
*   類型安全：利用 TypeScript 泛型提供端到端的類型安全
*   狀態管理整合：支持與流行的狀態管理庫（如 Nanostores、Redux 等）集成
*   **樂觀更新 (Optimistic Updates)**：內建支持客戶端樂觀更新，提供回滾和衝突解決機制。
*   **衝突解決 (Conflict Resolution)**：通過序列號 (Sequence IDs) 和時間戳管理並發衝突，提供可配置的解決策略。
*   **數據一致性**：包含檢測和恢復丟失更新的機制。

## 系統架構
1.  **核心層**
    *   類型定義：定義通用消息類型和接口
    *   抽象傳輸接口：提供插件式通信層
    *   通用工具類和函數：處理通用邏輯
2.  **客戶端層**
    *   Store 創建器：管理狀態、加載狀態和錯誤處理
    *   增量更新處理器：應用增量更新到本地狀態
    *   與其他庫的整合適配器：連接流行的狀態管理庫
3.  **服務器層**
    *   訂閱管理器：管理客戶端訂閱並派發更新
    *   請求處理器：處理初始狀態請求
    *   增量更新生成器：構建並發送增量更新
4.  **傳輸層適配器 (獨立包)**
    *   核心庫僅定義 `Transport` 接口。
    *   具體的適配器（如 WebSocket, VSCode postMessage, HTTP）將作為獨立的 `reqdelta-transport-*` npm 包提供。

## 消息格式
1.  **請求初始狀態 (Client → Server)**
    ```typescript
    {
      type: 'request',
      id: 'random-id',
      topic: 'topic-name',
      payload?: any // 可選參數
    }
    ```
2.  **響應初始狀態 (Server → Client)**
    ```typescript
    {
      type: 'response',
      id: 'request-id',
      topic: 'topic-name',
      payload: any,
      error?: string
    }
    ```
3.  **訂閱更新 (Client → Server)**
    ```typescript
    {
      type: 'subscribe',
      id: 'random-id',
      topic: 'topic-name'
    }
    ```
4.  **取消訂閱 (Client → Server)**
    ```typescript
    {
      type: 'unsubscribe',
      id: 'random-id',
      topic: 'topic-name'
    }
    ```
5.  **增量更新 (Server → Client)**
    ```typescript
    {
      type: 'update',
      topic: 'topic-name',
      delta: any // 增量更新數據
    }
    ```

## 增量更新策略
庫支持兩種主要的增量更新策略：
*   **自定義增量更新**：特定於應用的增量更新類型，如：
    ```typescript
    type ChatDelta =
      | { type: 'add_message'; message: Message }
      | { type: 'edit_message'; id: string; text: string }
      | { type: 'delete_message'; id: string };
    ```
*   **JSON Patch (RFC 6902)**：Standard JSON modification format, suitable for general cases.

## Optimistic Updates & Conflict Resolution
*   **Core Mechanism**: Client maintains both a "confirmed state" and an "optimistic state". State is snapshotted before applying local updates to allow rollback on server rejection or conflict.
*   **Sequence IDs**: Client assigns `clientSeq` to local updates. Server assigns global `serverSeq` to successfully applied updates. Server confirms client updates via `ack` messages containing `serverSeq`.
*   **Message Extensions**: `update` messages include `serverSeq` and optional `prevServerSeq` (for detecting lost messages). New `ack` message type for server confirmation. New client message type for submitting optimistic updates. New message type for requesting missing updates.
*   **Conflict Handling**: Provides configurable strategies (e.g., client-wins, server-wins, custom) and interfaces to handle conflicts between optimistic updates and server updates.
*   **Recovery Mechanism**: Client can detect gaps in `serverSeq` and request missing updates. Server needs to maintain a history buffer of recent updates to fulfill recovery requests.

## 項目結構 (Monorepo)
```
/
├── packages/
│   ├── core/                 # @reqdelta/core 核心庫
│   │   ├── src/
│   │   │   ├── core/
│   │   │   │   ├── types.ts
│   │   │   │   └── utils.ts
│   │   │   ├── client/
│   │   │   │   ├── createStore.ts
│   │   │   │   └── index.ts
│   │   │   ├── server/
│   │   │   │   ├── subscriptionManager.ts
│   │   │   │   ├── requestHandler.ts
│   │   │   │   └── index.ts
│   │   │   ├── deltas/
│   │   │   │   ├── jsonPatch.ts
│   │   │   │   ├── customDelta.ts
│   │   │   │   └── index.ts
│   │   │   └── integrations/
│   │   │       ├── nanostores.ts
│   │   │       ├── redux.ts
│   │   │       └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── transport-websocket/  # @reqdelta/transport-websocket (示例)
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── ...                   # 其他 transport 或集成包
├── examples/
│   ├── vscode-extension/     # VSCode 擴展示例
│   └── web-app/              # Web 應用示例
├── package.json              # Monorepo 根 package.json (定義 workspace)
└── tsconfig.base.json        # (可選) 基礎 tsconfig
```

## 工作流程
**客戶端初始化流程**
1.  創建傳輸適配器實例
2.  使用 `createStore` 創建帶有初始狀態的商店
3.  自動請求初始狀態
4.  自動訂閱增量更新

**服務器初始化流程**
1.  創建傳輸適配器實例
2.  初始化訂閱管理器和請求處理器
3.  註冊請求處理器以回應初始狀態請求
4.  監聽客戶端連接和訂閱請求

**增量更新流程**
1.  服務器檢測到數據變化
2.  服務器創建增量更新對象
3.  服務器使用訂閱管理器向相關訂閱客戶端發送更新
4.  客戶端接收並應用增量更新到本地狀態
5.  客戶端通知訂閱者狀態已更新

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

## 安裝和使用 (示例)
```bash
# 安裝核心庫和特定 transport
npm install @reqdelta/core @reqdelta/transport-websocket
```

This design provides a flexible, strongly-typed, and transport-agnostic solution for ReqRes + PubSub incremental update patterns across various scenarios, enhancing the efficiency and consistency of client-server communication, including support for optimistic updates and conflict resolution.
