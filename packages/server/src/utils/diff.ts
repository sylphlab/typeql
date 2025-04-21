import { compare, Operation as JsonPatchOperation } from 'fast-json-patch';

/**
 * Calculates the difference between two states and returns an array of JSON Patch operations.
 * Uses the 'fast-json-patch' library for efficient comparison.
 *
 * @template T The type of the states being compared.
 * @param oldState The previous state.
 * @param newState The current state.
 * @returns An array of JSON Patch operations representing the difference.
 * @throws {Error} If the comparison operation fails.
 */
export function diffStatesToJsonPatch<T>(oldState: T, newState: T): JsonPatchOperation[] {
  try {
    // Ensure states are plain objects/arrays suitable for comparison if necessary
    // (fast-json-patch generally handles standard JSON-compatible types well)
    const patches = compare(oldState as any, newState as any);
    return patches;
  } catch (error: unknown) {
    // Log the error for server-side debugging?
    console.error("Error generating JSON Patch:", error);
    // Re-throw a more specific error or handle as needed
    if (error instanceof Error) {
      throw new Error(`Failed to generate JSON Patch: ${error.message}`);
    }
    throw new Error('An unknown error occurred while generating the JSON Patch.');
  }
}

// Re-export the type for convenience if not defined elsewhere centrally
export type { JsonPatchOperation };