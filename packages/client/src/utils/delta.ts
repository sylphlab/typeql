import { applyPatches } from './patches';
import type { Patch } from '../coordinator';

/**
 * Applies a server delta (assumed to be JSON Patch array or a full snapshot)
 * to the current state.
 *
 * @param currentState The current confirmed state.
 * @param delta The delta received from the server (JSON Patch array or snapshot).
 * @returns The next state after applying the delta.
 */
export function applyDelta<T>(currentState: T, delta: Patch[] | T): T {
    if (Array.isArray(delta)) {
        // Apply JSON patches
        if (currentState && typeof currentState === 'object') {
            // Ensure patches is readonly for applyPatches if needed by its signature
            return applyPatches(currentState as object, delta as readonly Patch[]) as T;
        } else {
            console.warn("Cannot apply delta patches to non-object state:", currentState);
            return currentState; // Return current state if patches cannot be applied
        }
    } else {
        // Replace state with the full snapshot
        return delta;
    }
}