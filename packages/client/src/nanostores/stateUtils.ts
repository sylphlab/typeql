import { applyPatch, type Operation as PatchOperation, type JsonPatchError } from 'fast-json-patch';

/**
 * Type definition for the delta applicator function.
 * Applies JSON patches to a given state.
 *
 * @template TState The type of the state.
 * @param currentState The current state to apply patches to.
 * @param patches An array of JSON Patch operations (RFC 6902).
 * @returns The new state after applying the patches.
 * @throws {JsonPatchError} If applying patches fails.
 */
export type DeltaApplicator = <TState>(
    currentState: TState,
    patches: readonly PatchOperation[]
) => TState;

/**
 * Default implementation of the DeltaApplicator using fast-json-patch.
 * Applies JSON patches immutably.
 *
 * @template TState The type of the state.
 * @param currentState The current state. Can be undefined.
 * @param patches The JSON Patch operations to apply.
 * @returns The new state after applying patches.
 * @throws {JsonPatchError} Propagates errors from fast-json-patch.
 */
export const applyJsonDelta: DeltaApplicator = <TState>(
    currentState: TState, // Allow undefined for initial states
    patches: readonly PatchOperation[]
): TState => {
    if (patches.length === 0) {
        return currentState;
    }

    // fast-json-patch's applyPatch handles immutability.
    // It might throw JsonPatchError if patches are invalid.
    // The `validate` parameter could be used for stricter checking if needed.
    // Ensure currentState is not undefined if patches exist, provide a default if necessary,
    // although fast-json-patch might handle undefined base for 'add' ops on root.
    // Let's assume the caller ensures a valid base state or handles potential errors.
    const result = applyPatch(
        currentState,
        patches as PatchOperation[] // Cast readonly away if needed by applyPatch signature
        // Consider adding , /* validate */ true for stricter validation
    );

    return result.newDocument;
};