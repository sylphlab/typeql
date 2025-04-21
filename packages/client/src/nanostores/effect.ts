import type { Atom, ReadableAtom } from 'nanostores';

// Define the recipe function type, similar to Immer's produce
export type ApplyPatchRecipe<TState, TInput> = (
  // Use 'draft' to signal Immer-like behavior if applicable, otherwise 'currentState'
  draft: TState,
  input: TInput,
) => TState | void; // Return void signals mutation in place

// Define the structure of the configuration object returned by effect()
export type EffectConfig<TState = any, TInput = any> = {
  // Using 'any' for TState initially, will be inferred by usage in effect()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetAtom: Atom<any>; // The atom to apply the optimistic update to
  applyPatchRecipe: ApplyPatchRecipe<TState, TInput>;
  __effectMarker?: true; // Optional marker for type checking/debugging
};

/**
 * Creates a configuration object for an optimistic update effect.
 * This is used within the `effectsArray` parameter of the `mutation` helper.
 *
 * @template TState The type of the state managed by the target atom's data field.
 * @template TInput The type of the input passed to the mutation's `mutate` function.
 * @param targetAtom The Nanostore atom (typically created by `query` or `subscription`) whose state should be optimistically updated. It's expected to have a shape like `{ data: TState | undefined, ... }`.
 * @param applyPatchRecipe A function that takes the current state (or an Immer-like draft) and the mutation input, and returns the next state or modifies the draft in place.
 * @returns An EffectConfig object to be used in the `mutation` helper.
 */
export function effect<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TargetAtom extends Atom<any>, // General Atom type
  TInput,
>(
  targetAtom: TargetAtom,
  // Infer TState from the Atom's value shape if possible, otherwise fallback needed
  // This inference might be complex depending on Atom's exact type definition
  applyPatchRecipe: ApplyPatchRecipe<
    TargetAtom extends Atom<infer TValue>
      ? TValue extends { data: infer TData | undefined }
        ? TData
        : TValue // Fallback if no 'data' property
      : unknown, // Fallback if Atom type is not inferrable
    TInput
  >,
): EffectConfig<
  TargetAtom extends Atom<infer TValue>
    ? TValue extends { data: infer TData | undefined }
      ? TData
      : TValue
    : unknown,
  TInput
> {
  return {
    targetAtom,
    // Type assertion needed because TS struggles inferring TState perfectly here
    applyPatchRecipe: applyPatchRecipe as ApplyPatchRecipe<any, TInput>,
    __effectMarker: true,
  };
}

// Helper type to check if something is an EffectConfig
export function isEffectConfig(obj: unknown): obj is EffectConfig {
  return typeof obj === 'object' && obj !== null && '__effectMarker' in obj;
}