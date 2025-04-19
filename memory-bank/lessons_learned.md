# Lessons Learned

*   Initial content placeholder. Document key learnings and insights here to inform future decisions and avoid repeating mistakes.

---

## 2025-04-19: `useQuery` State Management & Test Flakiness

**Context:** Debugging `useQuery` hook in `@sylphlab/typeql-react` to fix test failures and improve coverage.

**Observation:** Managing state transitions (`loading`, `success`, `error`, `isFetching`) across multiple `useEffect` hooks (one for initial fetch, one for store sync/subscription) proved extremely difficult and prone to race conditions. Tests failed inconsistently depending on timing, especially when initial data was synced from the store before the initial fetch logic ran, or when errors occurred during initial sync. Attempts to fix the two-effect structure were unsuccessful. The consolidated effect approach also failed initially due to incorrect dependency arrays (`data`, `status`) and flawed logic for setting the final `'success'` status.

**Hypothesis:** Separating concerns into multiple effects that modify the same core state (`status`, `data`, `error`) without careful coordination leads to unpredictable state transitions. Including state variables in the dependency array of the effect that sets them causes infinite loops.

**Experiment:** Refactored the hook to use a single consolidated `useEffect` responsible for initial sync, store subscription, and triggering the initial fetch based on staleness. Used `useRef` hooks (`dataRef`, `statusRef`, `errorRef`, `isFetchingRef`) to read the *latest* state values within the effect and listener callbacks without adding the state variables themselves to the dependency array, preventing infinite loops. The core logic became:
    1. Effect runs on `enabled`, `inputKey`, `store`, `select`, `executeQuery`, `staleTime`.
    2. Handle `!enabled` case (reset state).
    3. Handle `statusRef.current === 'error'` case (do nothing).
    4. Perform initial sync (`try...catch`). Update `data` state and `lastFetchTimeRef` *only*. If error, set `error` and `status` state, then return.
    5. Setup store listener (if sync ok). Listener updates `data` state and `lastFetchTimeRef`, and sets `status` to `'success'` if not error.
    6. Determine `needsFetch` based on `didSync` and `isStale`.
    7. If `needsFetch`, call `executeQuery` (which handles its own `loading`/`success`/`error` status updates).
    8. If `!needsFetch` (synced and fresh), *only then* set `status` to `'success'` if it's not already `'success'` or `'error'`.

**Result:** This consolidated approach with refs and corrected dependency management resolved the test failures.

**Lesson:** When multiple asynchronous operations or effects need to coordinate updates to the same state variables (especially status flags), consolidating the logic into a single effect and using refs (`useRef`) to access the latest state values within callbacks/async operations (to avoid stale closures and incorrect dependency arrays) is a more robust pattern than relying on multiple independent effects. Be careful about when status transitions occur, especially ensuring `'success'` is only set after all conditions (sync, fetch, staleness) are resolved. Test flakiness often points to race conditions in hook logic. Ensure dependency arrays for `useEffect` are correct and do not include state variables set within that same effect.
