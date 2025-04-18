// packages/preact/src/index.ts

// Re-export context, provider and core hook
export * from './context';

// Re-export hooks
export * from './hooks/useTypeQLClient';
export * from './hooks/useQuery';
export * from './hooks/useMutation';
export * from './hooks/useSubscription';

// Log load (optional, kept from original)
console.log("@typeql/preact loaded: Provider, useTypeQLClient, useQuery, useMutation, useSubscription");
