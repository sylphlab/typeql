/**
 * Nanostores binding helpers for zenQuery.
 * These functions create Nanostore atoms that interact with the zenQuery client
 * and its OptimisticSyncCoordinator to provide reactive state management
 * with optimistic updates.
 */

export { query, type QueryMapState as QueryAtomState, type QueryOptions } from './query'; // Renamed QueryMapState
export { subscription, type SubscriptionAtomState, type SubscriptionOptions, type SubscriptionStatus } from './subscription';
export { mutation, effect, type MutationAtomState, type MutationOptions } from './mutation';

// Optionally re-export atom registry utilities if they are intended for public use
// export * from '../utils/atomRegistry';