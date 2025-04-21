import { produceWithPatches as immerProduceWithPatches, applyPatches as immerApplyPatches, type Patch as ImmerPatch } from 'immer';
import type { Patch } from '../coordinator'; // Our JSON Pointer based Patch type

// Re-export Immer's functions for internal use, converting patch formats as needed.

/** Converts Immer's array path to a JSON Pointer string path */
function immerPathToJsonPointer(path: (string | number)[]): string {
    if (path.length === 0) return '';
    return '/' + path.map(segment => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/** Converts a JSON Pointer string path back to Immer's array path */
function jsonPointerToImmerPath(pointer: string): (string | number)[] {
    if (pointer === '') return [];
    if (!pointer.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${pointer}`);
    return pointer.substring(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    // Note: This doesn't handle array indices correctly if they need to be numbers.
    // Immer's path segments can be numbers for array indices. Refinement might be needed
    // if numerical indices are critical for applyPatches.
}

/**
 * Wrapper around Immer's produceWithPatches.
 * Generates the next state based on a recipe and produces JSON patches (using JSON Pointer paths).
 *
 * @template T The type of the state.
 * @param baseState The initial state.
 * @param recipe A function that receives a draft state and can modify it.
 * @returns An object containing the next state, patches, and inverse patches.
 */
export function produceWithPatches<T>(
    baseState: T,
    recipe: (draft: T) => T | void,
): { nextState: T; patches: Patch[]; inversePatches: Patch[] } {
    const [nextState, immerPatches, immerInversePatches] = immerProduceWithPatches(baseState, recipe);

    // Convert Immer patches to our JSON Pointer format
    const convertPatches = (immerPatchList: readonly ImmerPatch[]): Patch[] =>
        immerPatchList.map(p => ({
            ...p,
            path: immerPathToJsonPointer(p.path),
        }));

    return {
        nextState,
        patches: convertPatches(immerPatches),
        inversePatches: convertPatches(immerInversePatches),
    };
}

/**
 * Wrapper around Immer's applyPatches.
 * Applies an array of JSON patches to a state.
 *
 * @template T The type of the state.
 * @param baseState The initial state.
 * @param patches An array of JSON patches (RFC 6902).
 * @returns The state after applying the patches.
 */
// Add constraint T extends object because immerApplyPatches expects an object/array
export function applyPatches<T extends object>(baseState: T, patches: readonly Patch[]): T {
    // Immer's applyPatches works directly with JSON Patch format if paths are strings.
    // Cast the return type as Immer returns Objectish which might not match T exactly.
    // The constraint T extends object helps, but casting ensures compatibility.
    // Also cast input patches to ImmerPatch[] as Immer's internal types might be stricter.
    // Pass original patches (with string paths) directly to immerApplyPatches.
    // Use 'as any' to bypass strict type checking for now, assuming immer handles standard JSON Patch.
    // Keep the 'as T' cast for the return type.
    return immerApplyPatches(baseState, patches as any) as T;
}