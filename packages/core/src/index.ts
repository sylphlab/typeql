export * from './core';
export * from './client';
// Explicitly export optimistic store parts from client module
export { createOptimisticStore } from './client/optimisticStore'; // Export factory function normally
export type { OptimisticStore, OptimisticStoreOptions, DeltaApplicator, PredictedChange, OptimisticStoreError } from './client/optimisticStore'; // Export types using 'export type' - Added DeltaApplicator, OptimisticStoreError, removed ApplyDeltaFn
export * from './server';
// Export deltas and integrations later when implemented
// export * from './deltas';
// export * from './integrations';
