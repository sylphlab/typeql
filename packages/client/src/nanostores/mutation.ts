import { map, onMount, task, type ReadableAtom, type Atom, type MapStore } from 'nanostores'; // Import MapStore
import type { Patch, Draft } from 'immer'; // Immer patches for optimistic updates
import type { default as PatchOperation } from 'fast-json-patch'; // Use default import with alias

import type { ZenQueryClient } from '../client';
import type { OptimisticSyncCoordinator } from '../coordinator';
import { generateAtomKey, registerAtom, unregisterAtom, getAtom, type AtomKey } from '../utils/atomRegistry';
import { applyImmerPatches, produceImmerPatches } from './patchUtils'; // Use Immer utils

// --- Utility Functions ---

// Helper to access nested properties using a dot-separated path string
function getNestedProperty(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => {
    return current?.[key];
  }, obj);
}


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
  // Target atom needs key and get method, assume it's a MapStore
  targetAtom: MapStore<QuerySubscriptionMapState<TData, any>> & { key: AtomKey },
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
  // Add options like onSuccess, onError, onSettled callbacks later
}

// Type for the selector function to get the client instance
type ClientGetter = <T extends ZenQueryClient>(clientAtom: Atom<T>) => T;

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
 * @param clientAtom The Nanostore atom holding the ZenQueryClient instance.
 * @param clientGetter A function to extract the client instance from the atom.
 * @param procedurePath The path to the mutation procedure (e.g., 'posts.create').
 * @param effectsArray An array of MutationEffect objects defining optimistic updates.
 * @param options Mutation configuration options.
 * @returns A Nanostore map atom with a `mutate` function.
 */
export function mutation<
  TClient extends ZenQueryClient,
  TInput = unknown, // Input/Variables type for the mutation procedure
  TOutput = any,   // Output type of the mutation procedure
  TError = Error,
>(
  clientAtom: Atom<TClient>,
  clientGetter: ClientGetter,
  procedurePath: string | string[], // TODO: Use selector function approach?
  effectsArray: MutationEffect<TInput, any>[] = [], // Effects array
  options: MutationOptions<TOutput, TError, TInput> = {}
): MutationAtom<TOutput, TError, TInput> {

  const client = clientGetter(clientAtom);
  const coordinator = client.getCoordinator();
  const normalizedPath = Array.isArray(procedurePath) ? procedurePath.join('.') : procedurePath;

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

              // Assume getAtom returns the MapStore registered by query/subscription
              const targetMapAtom = getAtom(atomKey) as MapStore<QuerySubscriptionMapState<any, any>> | undefined;
              if (!targetMapAtom) {
                  console.warn(`[mutation] Rollback skipped: Target map atom not found for key ${atomKey}`);
                  return;
              }

              // Rollback needs to apply inverse patches to the *current optimistic state*
              const currentOptimisticState = targetMapAtom.get().data;

              // Apply inverse Immer patches using the utility
              // Cast needed if TState constraint isn't sufficient
              const rolledBackState = applyImmerPatches(currentOptimisticState as any, inversePatches);

              // Update the atom's optimistic data directly
              targetMapAtom.setKey('data', rolledBackState);
              console.log(`[mutation] Rolled back optimistic data for atom ${atomKey}`);

              // Coordinator handles removing failed mutation patches.
              // Query/Sub atoms recompute on coordinator state change.
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
      if (!unsubscribeRollback) {
          unsubscribeRollback = coordinator.onRollback(handleRollback);
      }
      return () => {
          unsubscribeRollback?.();
          unsubscribeRollback = null;
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

        const clientSeq = coordinator.generateClientSeq();
        const patchesByAtom = new Map<AtomKey, Patch[]>();
        const inversePatchesByAtom = new Map<AtomKey, Patch[]>();

        // Apply optimistic updates
        try {
            effectsArray.forEach(effectItem => {
                const { targetAtomKey, applyRecipe } = effectItem;
                const targetMapAtom = getAtom(targetAtomKey) as MapStore<QuerySubscriptionMapState<any, any>> | undefined;
                if (!targetMapAtom) {
                    console.warn(`[mutation] Optimistic update skipped: Target atom not found for key ${targetAtomKey}`);
                    return;
                }

                const currentOptimisticState = targetMapAtom.get().data;
                const [nextState, patches, inversePatches] = produceImmerPatches(
                    currentOptimisticState as any,
                    (draft) => applyRecipe(draft, variables)
                );

                // Update target atom's optimistic data
                targetMapAtom.setKey('data', nextState); // Use setKey on the map atom

                if (patches.length > 0) {
                    const existingPatches = patchesByAtom.get(targetAtomKey) ?? [];
                    patchesByAtom.set(targetAtomKey, existingPatches.concat(patches));
                }
                if (inversePatches.length > 0) {
                    const existingInversePatches = inversePatchesByAtom.get(targetAtomKey) ?? [];
                    inversePatchesByAtom.set(targetAtomKey, existingInversePatches.concat(inversePatches));
                }
            });

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

            unsubAck = coordinator.on('onAck', (seq, result) => {
                if (seq === clientSeq) {
                    if (mutationMapAtom.get().status === 'loading' && mutationMapAtom.get().variables === variables) {
                        mutationMapAtom.set({
                            data: result as TOutput,
                            loading: false, error: null, variables, status: 'success',
                        });
                    }
                    cleanup();
                    resolve(result as TOutput);
                }
            });

            unsubError = coordinator.on('onError', (seq, error) => {
                if (seq === clientSeq) {
                     if (mutationMapAtom.get().status === 'loading' && mutationMapAtom.get().variables === variables) {
                        mutationMapAtom.set({
                            data: undefined, loading: false,
                            error: error instanceof Error ? error as TError : new Error('Mutation failed') as TError,
                            variables, status: 'error',
                        });
                    }
                    cleanup();
                    reject(error);
                }
            });

            try {
                // Use helper to access potentially nested procedure object
                const procedureObject = getNestedProperty(client.mutation, normalizedPath);
                if (typeof procedureObject?.mutate !== 'function') {
                    throw new Error(`[zenQuery] Procedure 'mutation.${normalizedPath}' not found or is not a function.`);
                }
                // Call mutate on the resolved procedure object
                procedureObject.mutate({ input: variables, clientSeq });
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

    // Wrap the mutator with task() to manage concurrency.
    // We still call the original mutator() to execute.
    const executeMutation = task(mutator); // task() returns the wrapped function
    // Call the original mutator function. task() intercepts this call.
    return mutator();
  };


  const exposedAtom = {
    ...mutationMapAtom,
    mutate,
  };

  // Cast to satisfy the interface
  return exposedAtom as MutationAtom<TOutput, TError, TInput>;
}