import { map, onMount, task, computed, get, type ReadableAtom, type Atom, type MapStore, type Store } from 'nanostores'; // Restore get
// Remove import from @nanostores/core
import type { Patch, Draft } from 'immer'; // Immer patches for optimistic updates
// Import selector type
import { type ProcedureClientPathSelector } from './query';

import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator, CoordinatorEvents } from '../coordinator'; // Import CoordinatorEvents
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches, produceImmerPatches } from './patchUtils'; // Use Immer utils

// Local definition as workaround for import issues (if needed, though mutation doesn't use it directly)
// interface PatchOperation { ... }

// --- Utility Functions ---

// Helper to access nested properties using a dot-separated path string - REMOVED (Procedure resolved via selector)
// function getNestedProperty(obj: any, path: string): any { ... }


// --- Effect Helper ---

// Helper type from query.ts/subscription.ts - needed for effect target atom type check
interface QuerySubscriptionMapState<TData = unknown, TError = Error> {
  data: TData | undefined;
  loading?: boolean; // Optional for subscription
  error: TError | null;
  status: string; // General status string
}


export interface MutationEffect<TInput = any, TData = any> {
  targetAtomKey: AtomKey; // Key to find the target atom in the registry
  // Immer-style recipe function
  applyRecipe: (currentState: Draft<TData | undefined>, input: TInput) => TData | undefined | void;
}

/**
 * Defines an optimistic update effect for a mutation.
 *
 * @param targetAtom The Nanostore map atom (created by query/subscription) to update optimistically. Must have a 'key' property.
 * @param applyRecipe An Immer-style recipe function to apply the optimistic change.
 * @returns A MutationEffect configuration object.
 */
export function effect<TInput = any, TData extends object | unknown[] = any>(
  // Target atom needs key and get method, assume it's a MapStore or similar Atom
  targetAtom: (MapStore<QuerySubscriptionMapState<TData, any>> | Atom<QuerySubscriptionMapState<TData, any>>) & { readonly key: AtomKey },
  applyRecipe: (currentState: Draft<TData | undefined>, input: TInput) => TData | undefined | void
): MutationEffect<TInput, TData> {
  if (!targetAtom?.key) {
      throw new Error('[zenQuery] Target atom provided to effect() must have a valid "key" property.');
  }
  return {
    targetAtomKey: targetAtom.key,
    applyRecipe,
  };
}


// --- Mutation Atom ---

// Define the shape of the state managed by the mutation map atom
export interface MutationAtomState<TData = unknown, TError = Error, TVariables = unknown> {
  data: TData | undefined; // Data returned by the mutation on success
  loading: boolean;
  error: TError | null;
  variables: TVariables | undefined; // Variables used in the last mutate call
  status: 'idle' | 'loading' | 'success' | 'error';
}

// Define options for the mutation helper
export interface MutationOptions<TData = unknown, TError = Error, TVariables = unknown> {
  effects?: MutationEffect<TVariables, any>[]; // Effects moved here
  // Add options like onSuccess, onError, onSettled callbacks later
}

// Remove local type definition - will import from query.ts
// type ProcedureClientPathSelector<...> = ...

// Type for the mutate function exposed by the atom
export type MutateFunction<TData = unknown, TError = Error, TVariables = unknown> =
  (variables: TVariables) => Promise<TData | undefined>; // Promise resolves on success, rejects on error

// Type for the returned atom
export interface MutationAtom<TData = unknown, TError = Error, TVariables = unknown>
  extends ReadableAtom<MutationAtomState<TData, TError, TVariables>>
{
  mutate: MutateFunction<TData, TError, TVariables>;
  // Add actions like reset later?
}

/**
 * Creates a Nanostore map atom to manage the state and execution of a ZenQuery mutation.
 *
 * @param procedureSelector A selector function returning the client and procedure.
 * @param options Mutation configuration options including optional effects.
 * @returns A Nanostore map atom with a `mutate` function.
 */
export function mutation<
  // Remove TClient generic
  TInput = unknown, // Input/Variables type for the mutation procedure
  TOutput = any,   // Output type of the mutation procedure
  TError = Error,
  // Infer procedure type from selector - TProcedure is now inner object { mutate: Func }
  // Proxy's mutate function doesn't return anything directly, it sends a message.
  TProcedure extends { mutate: (args: { input: TInput, clientSeq: number }) => void } = any
>(
  // Update function signature to use imported type
  procedureSelector: ProcedureClientPathSelector<TProcedure>,
  options?: MutationOptions<TOutput, TError, TInput> // Options are optional
): MutationAtom<TOutput, TError, TInput> {

  const { effects = [] } = options ?? {}; // Get effects from options, default to empty array

  // Remove preliminary call and stableAtomKey - not needed for mutation atom itself
  // const stableAtomKey = generateAtomKey(...);

  // Store the reactive procedure resolved in onMount
  let resolvedProcedure: TProcedure | null = null;

  // Use a map atom for mutation state
  const mutationMapAtom = map<MutationAtomState<TOutput, TError, TInput>>({
    data: undefined,
    loading: false,
    error: null,
    variables: undefined,
    status: 'idle',
  });

  // --- Rollback Handler ---
  const handleRollback = (inversePatchesByAtom: Map<AtomKey, Patch[]>) => { // Expect Immer patches
      console.warn('[mutation] Rollback triggered. Applying inverse Immer patches map...', inversePatchesByAtom);
      try {
          inversePatchesByAtom.forEach((inversePatches, atomKey) => {
              if (inversePatches.length === 0) return;

              // Assume getAtom returns the MapStore/Atom registered by query/subscription
              const targetAtom = getAtom(atomKey) as MapStore<QuerySubscriptionMapState<any, any>> | Atom<QuerySubscriptionMapState<any, any>> | undefined;
              if (!targetAtom) {
                  console.warn(`[mutation] Rollback skipped: Target map atom not found for key ${atomKey}`);
                  return;
              }

              // Rollback needs to apply inverse patches to the *current optimistic state*
              const currentOptimisticState = targetAtom.get().data;
              const rolledBackState = applyImmerPatches(currentOptimisticState as any, inversePatches);

              // Update the atom's optimistic data directly
              // Check if targetAtom has setKey (MapStore) or set (Atom)
              if ('setKey' in targetAtom && typeof targetAtom.setKey === 'function') {
                 targetAtom.setKey('data', rolledBackState);
              } else if ('set' in targetAtom && typeof targetAtom.set === 'function') {
                 // If it's a plain Atom, we might need to set the whole object
                 targetAtom.set({ ...targetAtom.get(), data: rolledBackState });
              } else {
                 console.error(`[mutation] Rollback failed: Target atom ${atomKey} has no 'set' or 'setKey' method.`);
                 throw new Error(`Cannot apply rollback to atom ${atomKey}`);
              }

              console.log(`[mutation] Rolled back optimistic data for atom ${atomKey}`);
          });

      } catch (error) {
          console.error('[mutation] Error applying rollback patches:', error);
          mutationMapAtom.setKey('error', error instanceof Error ? error as TError : new Error('Rollback failed') as TError);
          mutationMapAtom.setKey('status', 'error');
      }
  };

  // --- Coordinator Listener Registration ---
  let unsubscribeRollback: (() => void) | null = null;

  onMount(mutationMapAtom, () => {
      // Resolve reactive procedure and coordinator inside onMount
      const selectorResult = procedureSelector(get); // Use real 'get'
      // Validate selector result structure
      if (typeof selectorResult?.path !== 'string' || !selectorResult?.procedure?.mutate || !selectorResult?._isZenQueryProcedure) {
          console.error(`[zenQuery][mutation] Invalid result from procedureSelector in onMount. Expected { path: string, procedure: { mutate: Func }, _isZenQueryProcedure: true }`, selectorResult);
          // Cannot set error state here easily as mutation atom doesn't have its own key/status tied to this setup phase
          throw new Error('Internal configuration error: Invalid procedure selector result for mutation');
      }
      resolvedProcedure = selectorResult.procedure;

      // TODO: [TECH DEBT] Revisit coordinator access. Helpers should ideally receive client/coordinator via context or options.
      const clientAtom = getAtom('zenQueryClient') as Atom<ZenQueryClient> | undefined; // Placeholder for coordinator access
      if (!clientAtom) throw new Error("[zenQuery] Client atom ('zenQueryClient') not found. Ensure provider is set up or client is passed differently.");
      const coordinator = clientAtom.get().getCoordinator();

      if (!unsubscribeRollback) {
          unsubscribeRollback = coordinator.onRollback(handleRollback);
      }
      return () => {
          unsubscribeRollback?.();
          unsubscribeRollback = null;
          resolvedProcedure = null; // Clear resolved procedure on unmount
      };
  });


  // --- Mutate Function ---
  const mutate: MutateFunction<TOutput, TError, TInput> = (variables: TInput) => {
    // Define the core async logic inside mutate to capture variables
    const mutator = async (): Promise<TOutput | undefined> => {
        mutationMapAtom.set({ // Reset state on new mutation
            data: undefined,
            loading: true,
            error: null,
            variables,
            status: 'loading',
        });

        // Use the procedure resolved and stored during onMount
        if (!resolvedProcedure) {
            throw new Error("[zenQuery] Mutation called before component mount or after unmount.");
        }
        const procedure = resolvedProcedure;

        // Add placeholder coordinator access
        // TODO: [TECH DEBT] Revisit coordinator access. Helpers should ideally receive client/coordinator via context or options.
        const clientAtom = getAtom('zenQueryClient') as Atom<ZenQueryClient> | undefined; // Placeholder for coordinator access
        if (!clientAtom) throw new Error("[zenQuery] Client atom ('zenQueryClient') not found. Ensure provider is set up or client is passed differently.");
        const coordinator = clientAtom.get().getCoordinator();

        const clientSeq = coordinator.generateClientSeq();
        const patchesByAtom = new Map<AtomKey, Patch[]>();
        const inversePatchesByAtom = new Map<AtomKey, Patch[]>();

        // Apply optimistic updates
        try {
            effects.forEach(effectItem => { // Use effects from options
                const { targetAtomKey, applyRecipe } = effectItem;
                const targetAtom = getAtom(targetAtomKey) as MapStore<QuerySubscriptionMapState<any, any>> | Atom<QuerySubscriptionMapState<any, any>> | undefined;
                if (!targetAtom) {
                    console.warn(`[mutation] Optimistic update skipped: Target atom not found for key ${targetAtomKey}`);
                    return;
                }

                const currentOptimisticState = targetAtom.get().data;
                const [nextState, patches, inversePatches] = produceImmerPatches(
                    currentOptimisticState as any,
                    (draft) => applyRecipe(draft, variables)
                );

                // Update target atom's optimistic data
                 if ('setKey' in targetAtom && typeof targetAtom.setKey === 'function') {
                    targetAtom.setKey('data', nextState);
                 } else if ('set' in targetAtom && typeof targetAtom.set === 'function') {
                    targetAtom.set({ ...targetAtom.get(), data: nextState });
                 } else {
                    console.error(`[mutation] Optimistic update failed: Target atom ${targetAtomKey} has no 'set' or 'setKey' method.`);
                    throw new Error(`Cannot apply optimistic update to atom ${targetAtomKey}`);
                 }


                if (patches.length > 0) {
                    const existingPatches = patchesByAtom.get(targetAtomKey) ?? [];
                    patchesByAtom.set(targetAtomKey, existingPatches.concat(patches));
                }
                if (inversePatches.length > 0) {
                    const existingInversePatches = inversePatchesByAtom.get(targetAtomKey) ?? [];
                    inversePatchesByAtom.set(targetAtomKey, existingInversePatches.concat(inversePatches));
                }
            });

            // Pass Immer Patch[] to coordinator, aligning with onRollback signature
            coordinator.registerPendingMutation(clientSeq, patchesByAtom, inversePatchesByAtom);

        } catch (optimisticError) {
            console.error(`[mutation][${clientSeq}] Error applying optimistic updates:`, optimisticError);
            mutationMapAtom.set({
                data: undefined,
                loading: false,
                error: optimisticError instanceof Error ? optimisticError as TError : new Error('Optimistic update failed') as TError,
                variables,
                status: 'error',
            });
            throw optimisticError; // Reject the promise
        }

        // Server call and promise handling
        return new Promise<TOutput | undefined>((resolve, reject) => {
            let unsubAck: (() => void) | null = null;
            let unsubError: (() => void) | null = null;

            const cleanup = () => {
                unsubAck?.();
                unsubError?.();
            };

            // Use coordinator instance captured at the start of mutator
            // Add types for seq and result based on CoordinatorEvents
            // Use onAck directly instead of generic 'on'
            unsubAck = coordinator.onAck((seq: number, result?: any) => { // Use specific onAck signature
                if (seq === clientSeq) {
                    if (mutationMapAtom.get().status === 'loading' && mutationMapAtom.get().variables === variables) {
                        mutationMapAtom.set({
                            data: result as TOutput, // Use result from onAck
                            loading: false, error: null, variables, status: 'success',
                        });
                    }
                    cleanup();
                    resolve(result as TOutput);
                }
            });

            // Use onError directly instead of generic 'on'
            unsubError = coordinator.onError((seq: number, error: any) => { // Use specific onError signature
                if (seq === clientSeq) {
                     if (mutationMapAtom.get().status === 'loading' && mutationMapAtom.get().variables === variables) {
                        mutationMapAtom.set({
                            data: undefined, loading: false,
                            error: error as TError, // Use error from onError
                            variables, status: 'error',
                        });
                    }
                    cleanup();
                    reject(error);
                }
            });

            try {
                // Use the resolved procedure object
                procedure.mutate({ input: variables, clientSeq });
            } catch (invocationError) {
                 console.error(`[mutation][${clientSeq}] Error invoking procedure proxy:`, invocationError);
                 mutationMapAtom.set({
                     data: undefined, loading: false,
                     error: invocationError instanceof Error ? invocationError as TError : new Error('Mutation invocation failed') as TError,
                     variables, status: 'error',
                 });
                 cleanup();
                 reject(invocationError);
            }
        });
    };

    // Remove task wrapper for now
    // const executeMutation = task(mutator);
    return mutator();
  };


  const finalAtom = mutationMapAtom as any; // Use 'any' temporarily
  finalAtom.mutate = mutate;
  // No key property needed for mutation atom? Or generate based on selector? Let's omit for now.

  // Cast to satisfy the interface
  return finalAtom as MutationAtom<TOutput, TError, TInput>;
}