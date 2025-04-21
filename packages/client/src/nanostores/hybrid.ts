import { computed, type ReadableAtom } from 'nanostores';

import type { QueryAtom, QueryMapState } from './query';
import type { SubscriptionAtom, SubscriptionAtomState, SubscriptionStatus } from './subscription';

/** Status for the hybrid atom, combining query and subscription states. */
export type HybridStatus = 'idle' | 'loading' | 'connecting' | 'active' | 'error';

/** State shape for the hybrid atom. */
export interface HybridAtomState<TData = unknown, TError = Error> {
  /**
   * The data from the subscription if connected and available, otherwise from the query.
   * Undefined if neither has data or during initial loading/connecting states without initialData.
   */
  data: TData | undefined;
  /** Indicates if the query is loading or the subscription is connecting/reconnecting. */
  loading: boolean;
  /** The error from the subscription if present, otherwise from the query. Null if no error. */
  error: TError | null;
  /** The combined status reflecting the current state of query and subscription. */
  status: HybridStatus;
}

/**
 * Creates a computed Nanostore atom that intelligently combines the state
 * of a query atom and a subscription atom.
 *
 * It prioritizes data and status from the subscription when it's active,
 * falling back to the query state otherwise.
 *
 * @template TData The type of the data.
 * @template TError The type of the error.
 * @param queryAtom The atom created by the `query()` helper.
 * @param subscriptionAtom The atom created by the `subscription()` helper.
 * @returns A readable Nanostore atom representing the combined hybrid state.
 */
export function hybrid<TData extends object | unknown[] = any, TError = Error>(
  queryAtom: QueryAtom<TData, TError>,
  subscriptionAtom: SubscriptionAtom<TData, TError>
): ReadableAtom<HybridAtomState<TData, TError>> {

  return computed(
    [queryAtom, subscriptionAtom],
    (queryState, subState): HybridAtomState<TData, TError> => {
      const queryStatus = queryState.status;
      const subStatus = subState.status;

      let status: HybridStatus = 'idle';
      let data: TData | undefined = queryState.data; // Default to query data
      let error: TError | null = queryState.error; // Default to query error
      let loading: boolean = queryState.loading; // Default to query loading

      // --- Determine Combined Status ---
      if (subStatus === 'error' || queryStatus === 'error') {
        status = 'error';
      } else if (subStatus === 'connecting' || subStatus === 'reconnecting') {
        status = 'connecting';
      } else if (queryStatus === 'loading') {
        status = 'loading';
      } else if (subStatus === 'connected') {
        status = 'active';
      } else if (queryStatus === 'success') {
        status = 'active';
      } else {
        status = 'idle';
      }

      // --- Determine Data Source ---
      // Prioritize subscription data if it's connected/connecting and has data
      if ((subStatus === 'connected' || subStatus === 'connecting' || subStatus === 'reconnecting') && subState.data !== undefined) {
        data = subState.data;
      }
      // Note: If sub is connected but subState.data is undefined (e.g., initial state before first message),
      // it will still fall back to queryState.data if available.

      // --- Determine Error Source ---
      // Prioritize subscription error
      if (subState.error !== null) {
        error = subState.error;
      }

      // --- Determine Loading State ---
      // Loading if query is loading OR subscription is trying to connect
      loading = queryState.loading || subStatus === 'connecting' || subStatus === 'reconnecting';

      return {
        data,
        loading,
        error,
        status,
      };
    }
  );
}