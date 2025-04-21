# zenQuery - 綜合技術指引 (v1.1)

## A. 總體原則與命名

### A.1. 項目名稱
*   項目已正式定名為 **zenQuery**。所有相關組件、代碼庫、文檔應統一使用此名稱。

### A.2. 核心目標與定位
*   **目標:** 提供一個基於 RPC 模式嘅 Client/Server 通信方案，核心優勢在於利用 TypeScript 實現端到端類型安全 (Type-Safety)，並提供極佳嘅開發體驗 (DX)，特別係喺全 TypeScript 生態內無需額外代碼生成 (Code Generation)。
*   **整合:** 深度整合 Nanostores (現階段實現目標) 及未來 Zen Store，成為其生態 ("全家桶") 嘅一部分，提供無縫嘅狀態管理體驗。
*   **功能:** 支持健壯嘅 Optimistic Updates 同高效嘅實時數據同步 (Delta Updates)。
*   **架構原則:** 保持核心通訊邏輯同具體狀態管理庫 (Nanostores/Zen Store) 嘅解耦，實現關注點分離。

### A.3. 設計哲學比較與取捨
*   **RPC vs GraphQL:** 確認 zenQuery 採用 RPC 模型，Server 預先定義每個 Procedure 返回嘅完整數據結構。此模式優先考慮零 Code Gen 嘅端到端類型安全同 DX，接受 Server 定義返回結構嘅限制，不直接支持 GraphQL 式嘅 Client Field Selection。
*   **Over-fetching:** 接受 RPC 模式可能帶來嘅 API 傳輸層 over-fetching，優先保障類型安全。未來可通過定義更 spezifisch 嘅 Endpoints 或 Server Resolver 內部優化 (如利用 Client 傳遞嘅參數調整數據源查詢) 嚟緩解數據源層面嘅 over-fetching。Client Field Selection 嘅純 TS 類型推斷方案因極高複雜性同風險，暫不考慮。

## B. Server 端 API 設計

### B.1. 核心定義模式
*   **維持 Builder Pattern:** 繼續使用鏈式調用 Builder Pattern (例如 `t.query.input(...).resolve(...)`) 作為定義 Procedures 嘅基礎。此模式利用 TypeScript 逐步類型推斷，被認為喺類型安全實現嘅穩定性同可靠性方面優於 Configuration Object Pattern (尤其考慮到 Pothos 等複雜 Config Object 模式可能遇到嘅類型推斷問題)。

### B.2. Builder 結構
*   **拆分 Builder 類型:** 為提高 API 清晰度同解決潛在方法命名衝突，將基礎 `ProcedureBuilder` 根據 Procedure 類型 (query, mutation, subscription) 拆分成獨立嘅 Class：
    *   `QueryBuilder<Ctx, Input, Output>`
    *   `MutationBuilder<Ctx, Input, Output>`
    *   `SubscriptionBuilder<Ctx, Input, InitialOutput, StreamOutput>`
*   每個特定 Builder Class 只暴露與其類型相關嘅方法。例如，`QueryBuilder` 只有 `.resolve()`，`SubscriptionBuilder` 只有 `.resolveInitial()` (optional) 和 `.stream()`。

### B.3. 抽象化與擴展 (例如 Relay 分頁)
*   **目標:** 在保持 Builder 語法一致性嘅前提下，封裝常用模式 (如 Relay 分頁) 嘅 boilerplate。
*   **優先探索 Overload Wrapper Function:** 採用創建 Wrapper Function (例如 `applyRelay(builder)`) 嘅方式。
    *   **簽名:** 該 Function 使用 Function Overloading，根據接收到嘅 Builder 類型 (`QueryBuilder`, `MutationBuilder`, `SubscriptionBuilder`) 提供唔同嘅返回類型同行為。
    *   **Query:** 當接收 `QueryBuilder` 時，返回一個特定嘅 `RelayQueryBuilder` 實例，後者提供 Relay 專用嘅鏈式方法 (例如 `.input()` 接收 Filter Schema, `.output()` 接收 Node Schema, `.relayResolve()` 接收核心 fetcher)。
    *   **Mutation/Subscription:** 當接收 `MutationBuilder` 或 `SubscriptionBuilder` 時，Overload 簽名應返回 `never` 或拋出錯誤，明確表示標準 Relay 不適用。
    *   **實現:** `applyRelay` 函數內部需使用 `instanceof` (假設 Builder 用 Class 實現) 或其他可靠機制進行運行時類型判斷。
    *   **複雜度:** 實現 `RelayQueryBuilder` 嘅泛型類型以確保類型喺鏈式調用中正確傳遞仍然係主要挑戰，但此方案被認為係兼顧一致性、抽象化同相對可控類型風險嘅最佳平衡點。
    *   **Tree-shaking:** 比直接擴展 Builder (`.relay()`) 風險稍低，但 `applyRelay` 函數本身可能無法被 tree-shake。

### B.4. 文件拆分與 Builder 實例管理
*   **問題:** 共享 `t` (Module Singleton) 雖然利用 TS 類型推斷，但唔純粹 (依賴外部狀態) 且唔支持多 Server 實例。傳遞 `t` 作為參數需要手動處理複雜類型簽名 (尤其對 Pothos 等複雜 Builder)。
*   **最終方案: 官方 Type Creator + 傳遞 `t`:**
    *   **前提:** 假設 `zenQuery` Server 庫會導出一個官方嘅 Builder 類型別名或泛型工具 (例如 `BuilderInstance<TContext>`)。
    *   **用法:**
        1.  喺創建 Server 或 Router 時，調用 `initZenQuery<SpecificContext>()` 創建局部嘅 `t` instance。
        2.  喺定義 Procedures 嘅獨立文件 (例如 `defineUserProcedures.ts`)，`import type { BuilderInstance } from '@sylphlab/zenquery-server'`。
        3.  定義一個接收 `t` 作為參數嘅 function: `export function defineUserProcedures(t: BuilderInstance<SpecificContext>) { ... return { proc1: t.query... } }`。
        4.  喺 Server 文件中，將創建嘅 `t` instance 傳入 `defineUserProcedures(t)`。
    *   **優點:** 支持多 Server/Context，符合依賴注入原則，避免手動處理複雜類型簽名，避免 Module Singleton 問題。

### B.5. Subscription API
*   **採用 Async Generator / yield:**
    *   `SubscriptionBuilder` 提供 `.stream(async function* streamer)` 方法，取代舊有嘅 `.subscribe(callback)`。
    *   `streamer` 函數內部使用 `yield` 推送數據。
    *   利用 `try...finally` 或 Generator 本身嘅結束機制處理 Cleanup。
*   **支持 Optional Initial State:**
    *   `SubscriptionBuilder` 提供 optional 嘅 `.resolveInitial(resolver)` 方法，用於定義訂閱建立時發送嘅初始狀態快照。
    *   Server Request Handler 需要相應調整，先執行 `initialResolver` (如果存在) 並發送結果，然後再迭代 `streamer`。
    *   Client Transport 和 `client.subscribe` 接口需要調整以處理可能存在嘅 Initial State 和後續 Stream。

### B.6. Delta (增量更新) 生成
*   **職責:** Server 端 Subscription Resolver (`.stream()` 內部) 負責監聽數據源變化，並生成 Delta。
*   **推薦格式:** 優先使用標準嘅 **JSON Patch (RFC 6902)** 作為 Delta 格式，因其標準化且 Client 端有成熟庫支持。
*   **(Future Idea - 中優先級) 提供 Diff Helper:** 考慮將來喺 `zenQuery` Server 庫提供內建嘅 `diff(oldState, newState): JsonPatch[]` 工具函數，以簡化 Resolver 內部計算 Patch 嘅邏輯，同時保持 Server 狀態管理嘅靈活性。
*   **API Usage (Subscription):**
    *   **彈性方案:** 為 `SubscriptionBuilder` 提供兩種 stream 方法：
        *   `.streamRaw(async function* streamer)`: 用戶 yield 完整狀態，Server 推送完整狀態。
        *   `.streamDiff(async function* streamer)`: 用戶 yield 完整狀態，zenQuery 內部 (可能用 Diff Helper) 自動計算 JSON Patch 並推送 Patch。
    *   呢個方案通過唔同方法名提供彈性，同時類型系統可以根據調用嘅方法推斷 Server 推送嘅類型 (Full State or Patch)。

## C. Client 端架構與實現

### C.1. 核心架構
*   採用「**OptimisticSyncCoordinator (引擎) + Nanostore Atoms (狀態) + Binding Helpers (橋樑)**」模式。
*   `zenQuery` Client instance (`createClient`) 內部持有一個獨立嘅 `OptimisticSyncCoordinator` 實例。

### C.2. OptimisticSyncCoordinator (引擎)
*   **定位:** 無狀態 (Stateless，唔儲存應用數據) 嘅同步邏輯引擎。
*   **職責:**
    *   管理 `clientSeq`, `confirmedServerSeq`。
    *   管理 `pendingMutations` 隊列 (包含 `clientSeq`, `mutationInfo`, `optimisticPatches`)。
    *   處理 Server 消息 (Ack, Delta, Error)。
    *   執行衝突解決 (需要可配置策略)。
    *   執行 Recomputation 相關計算。
*   **接口 (對內/對外):**
    *   `generateClientSeq(): number`
    *   `registerPendingMutation(data: { clientSeq: number; mutationInfo: any; optimisticPatches: Map<AtomKey, Patch[]> })`: 登記 Pending Mutation 及其對各 Atom 產生嘅 Patches。
    *   `confirmMutation(clientSeq: number)`: 處理 Ack。
    *   `rejectMutation(clientSeq: number, error?: any)`: 處理 Error，觸發 Rollback 計算。
    *   `processServerDelta(deltaMessage: { data: ServerDelta; serverSeq: number; prevServerSeq?: number }, deltaApplicator: DeltaApplicator)`: 處理 Server Delta，檢查序列號，處理衝突，觸發 Delta 應用。
    *   `getPendingPatches(): Map<AtomKey, Patch[]>`: 獲取所有有效 Pending Mutation 嘅 Patches (按 Atom 分組)。
    *   **(事件/回調)** `onStateChange(callback: () => void)`: 提供事件機制，當 Coordinator 內部狀態改變 (pending 隊列變化, confirmedSeq 更新) 可能導致 Optimistic State 需要重新計算時觸發。
    *   **(事件/回調)** `onApplyDelta(callback: (resolvedDelta: ServerDelta) => void)`: 當 `processServerDelta` 完成衝突處理後，觸發此事件，將最終需要應用嘅 Delta 交俾外部。
    *   **(事件/回調)** `onRollback(callback: (inversePatches: Map<AtomKey, Patch[]>) => void)`: 當 `rejectMutation` 計算出需要回滾嘅 Inverse Patches 時觸發。
*   **狀態解耦:** Coordinator 不直接讀寫外部 Atom 狀態。狀態讀取和應用由 Binding Helpers 負責。

### C.3. 狀態管理整合 (Nanostores)
*   **狀態儲存:** Nanostore Atoms 負責儲存應用程式嘅 confirmed state。
*   **Patch 機制:**
    *   依賴 Nanostores (或未來 Zen Store) 提供 Patch 生成 (`produceWithPatches`) 和應用 (`applyPatches`) 的能力。
    *   Binding Helpers (例如 `createMutationAtom`) 會使用 Store 提供嘅 `produceWithPatches` 來計算 Optimistic Update 嘅 Patches。
    *   Binding Helpers (例如 `createQueryAtom`) 會使用 Store 提供嘅 `applyPatches` 來計算 Optimistic State。
*   **Delta Applicator:**
    *   需要一個 `deltaApplicator` (由 Nanostore 綁定層提供或用戶配置)，其 `applyDelta(currentState, delta)` 方法知道如何將 Server 發送嘅 Delta (JSON Patch) 應用到 Nanostore Atom 上。
    *   `OptimisticSyncCoordinator` 的 `processServerDelta` 方法會接收並使用這個 `deltaApplicator` (或者觸發 `onApplyDelta` 事件由外部處理)。

### C.4. Binding Helpers (`createQueryAtom`, `createMutationAtom`)
*   **定位:** 作為 zenQuery Client/Coordinator 同 Nanostore Atoms 之間嘅橋樑。
*   **初始化:** 提供 `initZenQueryHelpers(clientAtom)` 或類似方式，接收 Client Atom (例如 `$client = atom(() => createClient(...))`)。返回 `createQueryAtom`, `createMutationAtom` 等 helpers。
*   **`createMutationAtom` (或 `useMutation` Hook 模式):**
    *   接收 Mutation Procedure 引用 (或 Path) 和 Optimistic Update 配置 (包含 target Atoms 列表及對應嘅 update recipe `(draft, input) => void`)。
    *   返回 `mutate` 函數和狀態 (loading, error)。
    *   `mutate(input)` 內部邏輯：
        1.  生成 `clientSeq`。
        2.  遍歷配置嘅 Atoms，讀取當前值。
        3.  使用 Zen Store `produceWithPatches` 執行 recipe，獲取 `optimisticState` 和 `patches` (及 `inversePatches`)。
        4.  更新 Atom 到 `optimisticState`。
        5.  調用 `coordinator.registerPendingMutation` 登記 `clientSeq` 和 `patches` (按 Atom 標識符分組)。
        6.  調用 `client.mutate` 發送請求。
        7.  (需要實現) 監聽 Coordinator 的 `onRollback` 事件，應用 `inversePatches` 到對應 Atom。
*   **`createQueryAtom` (或 `useQuery` Hook 模式):**
    *   接收 Query Procedure 引用 (或 Path) 和 Input (可以是靜態值或 Atom)。
    *   返回一個 Atom，其值包含 `data`, `loading`, `error` 等狀態。
    *   內部邏輯：
        1.  調用 `client.query` 獲取初始 confirmed state，存入內部狀態或直接更新 Atom。
        2.  監聽 Coordinator 的 `onStateChange` 事件。
        3.  監聽 Coordinator 的 `onApplyDelta` 事件：獲取 `resolvedDelta`，找到對應 Atom，調用 `deltaApplicator` 更新 Atom 的 confirmed state。
        4.  計算 Optimistic State (當 Atom confirmed state 變化或收到 `onStateChange` 時)：
            *   讀取 Atom 當前 confirmed state。
            *   調用 `coordinator.getPendingPatches()`。
            *   過濾出相關 Patches。
            *   用 Zen Store `applyPatches` 計算 optimistic state。
            *   更新 Atom 的 `data` 為 optimistic state。
        5.  管理 `loading`, `error` 狀態。

### C.5. Client Transport
*   **Batching:** 應考慮在 Transport 層提供 `batching: true` 選項。

## D. 未來考慮 (Future Ideas)

*   為 Server 端提供內建 Diff Helper (`diff(old, new) => JsonPatch[]`)。
*   實現 Builder Wrapper (`.relay()` on `QueryBuilder`)。
*   實現 Nanostores Binding Helpers (`createQueryAtom`, `createMutationAtom`)。
*   實現 Transport 層 Batching。
*   實現 Client Hooks 層 SWR (Stale-While-Revalidate) 和 Debounce。
*   考慮為 Subscription 提供更高級抽象 (例如 `.streamDiff`)。
*   執行項目改名 (`zenQuery`) 相關工作 (代碼庫、文檔、包名等)。
*   (長遠) 整合 Zen Store 的內建 Patch 功能。
*   (長遠) 探索 Resolver 內部 FP 改進 (Result Type, Effect Management)。

---