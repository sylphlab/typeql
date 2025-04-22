import { produceWithPatches, applyPatches, type Patch, type Draft } from 'immer';
import type { Operation as PatchOperation } from 'fast-json-patch'; // Keep for potential future use or type consistency if needed

/**
 * Applies an array of Immer patches to a base state immutably.
 *
 * @param baseState The initial state. Must be an object or array.
 * @param patches The array of Immer patches to apply.
 * @returns The new state after applying patches.
 * @throws If patch application fails.
 */
// Add constraint: TState must be an object or array for Immer
export function applyImmerPatches<TState extends object | unknown[]>(
    baseState: TState,
    patches: readonly Patch[]
): TState {
    // Immer's applyPatches handles immutability.
    // Relying on the constraint for type safety.
    return applyPatches(baseState, patches);
}

/**
 * Produces a new state and Immer patches based on a recipe function.
 *
 * @param baseState The initial state. Must be an object or array.
 * @param recipe A function that receives a draft state and modifies it.
 * @returns A readonly tuple containing [newState, patches, inversePatches].
 */
// Add constraint: TState must be an object or array for Immer
export function produceImmerPatches<TState extends object | unknown[]>(
    baseState: TState,
    recipe: (draft: Draft<TState>) => void | TState
): readonly [TState, Patch[], Patch[]] { // Return type is readonly
    // produceWithPatches returns a function that needs to be called with the base state
    const producer = produceWithPatches(recipe);
    // Cast baseState to 'any' to satisfy the Immutable<Draft<TState>> expectation.
    // Cast the first element of the result tuple to TState.
    const result = producer(baseState as any); // Cast input
    return [result[0] as TState, result[1], result[2]]; // Cast output state
}

// --- Optional: Conversion utilities if needed later ---
// These were in mutation.ts, keeping them here for potential reuse if
// direct conversion to JSON Patch becomes necessary elsewhere.

/**
 * Converts an Immer patch path array to a JSON Pointer string.
 * @param path - Array of path segments (string or number).
 * @returns JSON Pointer string.
 */
export function immerPathToJsonPointer(path: (string | number)[]): string {
  if (path.length === 0) return '';
  // Escape '~' and '/' according to JSON Pointer spec (RFC 6901)
  return '/' + path.map(segment => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/**
 * Converts an Immer Patch object to a fast-json-patch Operation object.
 * NOTE: This is a basic conversion and might not handle all edge cases perfectly.
 * Use with caution if strict JSON Patch adherence is required.
 *
 * @param immerPatch - The patch object from Immer.
 * @returns The corresponding fast-json-patch Operation object.
 */
export function convertImmerPatchToJsonPatchOperation(immerPatch: Patch): PatchOperation {
  // Cast needed because TS struggles with the discriminated union's 'op' type here
  const operationBase = {
    op: immerPatch.op,
    path: immerPathToJsonPointer(immerPatch.path),
  };

  if (immerPatch.op === 'add' || immerPatch.op === 'replace') {
    return { ...operationBase, value: immerPatch.value };
  }
  // 'remove' operation doesn't have a 'value' field in JSON Patch
  return operationBase as PatchOperation;
}