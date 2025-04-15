export * from './core';
export * from './client';
// Explicitly export optimistic store parts from client module
export { createOptimisticStore } from './client/optimisticStore'; // Export factory function normally
export type { OptimisticStore, OptimisticStoreOptions, ApplyDeltaFn, PredictedChange } from './client/optimisticStore'; // Export types using 'export type'
export * from './server';
// Export deltas and integrations later when implemented
// export * from './deltas';
// export * from './integrations';
