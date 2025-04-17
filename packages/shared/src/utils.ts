/**
 * Generates a simple pseudo-random ID.
 * NOTE: This is NOT cryptographically secure or guaranteed to be universally unique.
 * Replace with a more robust solution (like `uuid`) if necessary for production.
 * @param length The desired length of the ID. Defaults to 8.
 * @returns A pseudo-random string ID.
 */
export function generateId(length: number = 8): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

// --- Path Navigation & Standard Delta Application ---
import type { StandardDelta } from './types'; // Path is correct now
import { applyPatch as applyJsonPatch, Operation as JsonPatchOperation } from 'fast-json-patch'; // Import for patch/move

/**
 * Safely retrieves a value from a nested object or array using a path array.
 * Returns undefined if the path does not exist.
 * @param obj The object/array to navigate.
 * @param path An array of keys or indices representing the path.
 * @returns The value at the specified path, or undefined.
 */
export function getIn(obj: any, path: (string | number)[] | undefined | null): any {
    if (!path || path.length === 0) return obj;
    let current = obj;
    for (const key of path) {
        if (current === undefined || current === null) return undefined;
        // Handle both object keys and array indices
        current = typeof current === 'object' ? current[key] : undefined;
    }
    return current;
}


/**
 * Creates a new object/array with a value set at a nested path.
 * Creates intermediate paths (objects or arrays based on key type) if they don't exist.
 * Performs shallow copies at each level of the path.
 *
 * NOTE: This is a basic immutable update helper. For complex state, consider libraries like Immer.
 *
 * @param obj The original object/array.
 * @param path An array of keys or indices representing the path.
 * @param value The value to set at the path.
 * @returns A new object/array with the value set.
 */
export function setIn(obj: any, path: (string | number)[] | undefined | null, value: any): any {
  if (!path || path.length === 0) {
      // If path is empty, the value replaces the object, handle appropriately
      // This might need adjustment based on expected behavior at root level
      return typeof value === 'function' ? value(obj) : value;
  }

  const newRoot = Array.isArray(obj) ? [...obj] : { ...(obj ?? {}) };
  let currentLevel = newRoot;

  for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      // Ensure key is a valid index type before using it
      if (key === undefined || key === null) {
        console.error("ReqDelta: Invalid path segment in setIn:", key, "at index", i);
        return obj; // Return original object on invalid path
      }
      const nextKey = path[i + 1];
      let currentValue = currentLevel[key];

      // Determine if next level should be an array or object
      const nextLevelShouldBeArray = typeof nextKey === 'number'; // Crude check, assumes numeric keys mean array indices

      if (currentValue === undefined || currentValue === null) {
          // Create path if it doesn't exist
          currentValue = nextLevelShouldBeArray ? [] : {};
          currentLevel[key] = currentValue;
      } else {
          // Clone existing level if it exists and isn't already cloned at this step
          // Ensure key is valid before attempting to access obj
          const originalValueAtPath = obj ? getIn(obj, path.slice(0, i + 1)) : undefined;
          // Check prevents re-cloning if part of the path already existed partially
          if (currentValue === originalValueAtPath) {
             currentLevel[key] = Array.isArray(currentValue) ? [...currentValue] : { ...currentValue };
             currentValue = currentLevel[key]; // Update currentValue to the cloned version
          }
      }
      currentLevel = currentValue; // Move to the next level
  }

  const lastKey = path[path.length - 1];
   // Ensure lastKey is a valid index type
  if (lastKey === undefined || lastKey === null) {
      console.error("ReqDelta: Invalid final path segment in setIn:", lastKey);
      return obj; // Return original object on invalid path
  }
  // Allow value to be a function to update based on existing value
  currentLevel[lastKey] = typeof value === 'function' ? value(currentLevel[lastKey]) : value;

  return newRoot;
}


/**
 * Applies a standard delta to a given state immutably.
 * Assumes items in collections have an 'id' property for update/remove.
 * Uses getIn/setIn for path navigation.
 *
 * @template State The type of the overall state object.
 * @template Item The type of items within collections, must have an 'id'.
 * @param state The current state.
 * @param delta The standard delta to apply.
 * @returns The new state after applying the delta.
 */
export function applyStandardDelta<State, Item extends { id: string }>(
  state: State,
  delta: StandardDelta<Item, State> // Import StandardDelta from types.ts
): State {
  // Path access needs to happen inside the switch cases where it's guaranteed to exist
  // const path = delta.path ?? []; // REMOVED: Access path inside relevant cases

  try {
      switch (delta.type) {
          case 'add': {
              const path = delta.path ?? []; // Get path here
              // Get the current collection (or an empty array if path leads nowhere)
              const currentCollection = getIn(state, path) ?? [];
              if (!Array.isArray(currentCollection)) {
                  console.error(`ReqDelta: Cannot apply 'add' delta. Path [${path.join(', ')}] does not point to an array.`);
                  return state;
              }
              // Add the new item
              const newCollection = [...currentCollection, delta.item];
              return setIn(state, path, newCollection);
          }

          case 'update': {
              const path = delta.path ?? []; // Get path here
              const currentCollection = getIn(state, path) ?? [];
              if (!Array.isArray(currentCollection)) {
                  console.error(`ReqDelta: Cannot apply 'update' delta. Path [${path.join(', ')}] does not point to an array.`);
                  return state;
              }
              let found = false;
              const newCollection = currentCollection.map(item => {
                  if (item && typeof item === 'object' && 'id' in item && item.id === delta.id) {
                      found = true;
                      // Apply partial changes
                      return { ...item, ...delta.changes };
                  }
                  return item;
              });
              if (!found) {
                  console.warn(`ReqDelta: 'update' delta ignored. Item with ID "${delta.id}" not found at path [${path.join(', ')}].`);
                  return state; // Or return original collection? Decide consistency. Return state for safety.
              }
              return setIn(state, path, newCollection);
          }

          case 'remove': {
              const path = delta.path ?? []; // Get path here
              const currentCollection = getIn(state, path) ?? [];
              if (!Array.isArray(currentCollection)) {
                  console.error(`ReqDelta: Cannot apply 'remove' delta. Path [${path.join(', ')}] does not point to an array.`);
                  return state;
              }
              const newCollection = currentCollection.filter(item =>
                  !(item && typeof item === 'object' && 'id' in item && item.id === delta.id)
              );
              if (newCollection.length === currentCollection.length) {
                   console.warn(`ReqDelta: 'remove' delta ignored. Item with ID "${delta.id}" not found at path [${path.join(', ')}].`);
                   // No change, return original state
                   return state;
              }
              return setIn(state, path, newCollection);
          }

          case 'replace': {
              const path = delta.path ?? []; // Get path here
              // Replace the state at the specified path
              return setIn(state, path, delta.state);
          }

          case 'move': {
              // Convert MoveDelta to a JSON Patch 'move' operation
              // Note: This assumes fromPath and toPath are valid JSON Pointers
              const patch: JsonPatchOperation[] = [{ op: 'move', from: delta.fromPath, path: delta.toPath }];
              try {
                  // Apply the patch immutably (fast-json-patch handles cloning)
                  const result = applyJsonPatch(state, patch, true, false); // validate = true, mutateDocument = false
                  return result.newDocument as State;
              } catch (patchError) {
                  console.error(`ReqDelta: Error applying 'move' delta (converted to JSON Patch):`, delta, patchError);
                  return state; // Return original state on error
              }
          }

          case 'patch': {
              try {
                  // Apply the JSON Patch immutably, casting patch type
                  const result = applyJsonPatch(state, delta.patch as JsonPatchOperation[], true, false); // validate = true, mutateDocument = false
                  return result.newDocument as State;
              } catch (patchError) {
                  console.error(`ReqDelta: Error applying 'patch' delta:`, delta, patchError);
                  return state; // Return original state on error
              }
          }

          default:
              // This case should ideally be prevented by TypeScript's discriminated union checks
              // If it happens, it's an unknown delta type
              console.warn('ReqDelta: Unsupported standard delta type:', (delta as any).type);
              return state;
      }
  } catch (error) {
       console.error(`ReqDelta: Error applying delta:`, delta, error);
       return state; // Return original state on error to prevent corruption
  }
}


// --- Standard Operation to Delta Conversion ---

import type { StandardOperation } from './types'; // Path is correct now

/**
 * Converts a standard client operation into a standard delta for optimistic updates.
 *
 * @template Item The type of items within collections, must have an 'id'.
 * @template State The type of the overall state object.
 * @param operation The standard client operation.
 * @returns The corresponding standard delta, or null if conversion is not applicable/fails.
 */
export function standardOperationToDelta<Item extends { id: string }, State = any>(
    operation: StandardOperation<Item>,
    // Note: We might need the current state here for some complex conversions (e.g., 'move')
): StandardDelta<Item, State> | null {
    // Path access needs to happen inside the switch cases where it's guaranteed to exist
    // const path = operation.path; // REMOVED: Access path inside relevant cases
    switch (operation.type) {
        case 'add': {
            const path = operation.path; // Get path here
            // Create the delta using the client's temporary ID
            return {
                type: 'add',
                // Ensure the item structure matches Item, using tempId
                item: { ...operation.item, id: operation.tempId } as Item,
                // Explicitly handle undefined path for exactOptionalPropertyTypes
                ...(path !== undefined && { path }),
                tempId: operation.tempId // Include tempId in the delta for potential server correlation
            };
        }
        case 'update': {
            const path = operation.path; // Get path here
            return {
                type: 'update',
                id: operation.id,
                changes: operation.changes,
                // Explicitly handle undefined path
                ...(path !== undefined && { path })
            };
        }
        case 'remove': {
            const path = operation.path; // Get path here
            return {
                type: 'remove',
                id: operation.id,
                // Explicitly handle undefined path
                ...(path !== undefined && { path })
            };
        }
            case 'move':
                // Convert MoveOperation directly to MoveDelta
                return {
                    type: 'move',
                    id: operation.id,
                    fromPath: operation.fromPath,
                    toPath: operation.toPath,
                    ...(operation.index !== undefined && { index: operation.index }), // Include index if present
                    // Note: StandardDelta doesn't have a 'path' property for move, it uses fromPath/toPath
                };
            default:
                console.warn('ReqDelta: Unsupported standard operation type for delta conversion:', (operation as any).type);
                return null;
    }
}

/**
 * Default logic to check if a received server delta satisfies a pending client operation.
 *
 * @template Item The type of items within collections, must have an 'id'.
 * @template State The type of the overall state object.
 * @param delta The delta received from the server.
 * @param operation The pending client operation.
 * @returns True if the delta likely corresponds to the operation, false otherwise.
 */
export function standardMatchesPendingOperation<Item extends { id: string }, State = any>(
    delta: StandardDelta<Item, State>,
    operation: StandardOperation<Item>
): boolean {
    // Path check needs to be type-aware
    // if (delta.type !== 'move' && operation.type !== 'move') { // Check if NOT move ops
    //     const deltaPathStr = delta.path?.join('.') ?? '';
    //     const opPathStr = operation.path?.join('.') ?? '';
    //     if (deltaPathStr !== opPathStr) {
    //         return false;
    //     }
    // } else if (delta.type === 'move' && operation.type === 'move') {
    //     // For move, paths are different (from/to), rely on ID match below
    // } else {
    //      // If types mismatch regarding 'move', they can't match
    //      return false;
    // }
    // Simplified: Rely on ID matching below for most cases. Path matching is complex with 'move'.

    // Type-specific matching
    if (operation.type === 'add' && delta.type === 'add') {
        // Most reliable: Server's 'add' delta includes the 'tempId' from the client's operation.
        if (delta.tempId && operation.tempId) {
            return delta.tempId === operation.tempId;
        }
        // Fallback (less reliable): Check if content seems similar, e.g., text content
        // This requires knowledge of the Item structure and might be too fragile.
        // Example: return delta.item.text === (operation.item as any).text;
        console.warn("ReqDelta: Matching 'add' operation without tempId correlation is unreliable.");
        return false; // Default to false if tempId isn't used for correlation
    }
    if (operation.type === 'update' && delta.type === 'update') {
        // Match based on the ID of the item being updated
        return delta.id === operation.id;
    }
    if (operation.type === 'remove' && delta.type === 'remove') {
        // Match based on the ID of the item being removed
        return delta.id === operation.id;
    }
    if (operation.type === 'move' && delta.type === 'move') {
        // Match based on the ID of the item being moved
        return delta.id === operation.id;
    }
    // Note: 'patch' delta doesn't have a direct corresponding client 'operation' in StandardOperation yet.

    return false; // Default to no match
    }

// --- State Cloning Utility ---

/**
 * Default state cloning function. Uses structuredClone if available,
 * otherwise falls back to JSON.parse(JSON.stringify).
 * WARN: JSON fallback does not preserve Dates, RegExps, Functions, Maps, Sets, etc.
 * @param state The state to clone.
 * @returns A deep copy of the state, or undefined if input is undefined.
 */
export const defaultCloneState = <State>(state: State | undefined): State | undefined => {
    if (state === undefined) {
        return undefined;
    }
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(state);
        } catch (e) {
             console.error("[ReqDelta] structuredClone failed:", e, "Falling back to JSON clone.");
             // Fallback if structuredClone fails for some reason (e.g., contains functions)
        }
    }
    // Basic fallback - WARNING: Doesn't handle Date, RegExp, functions, etc.
    try {
        return JSON.parse(JSON.stringify(state));
    } catch(e) {
        console.error("[ReqDelta] JSON clone failed:", e, "Returning original state (mutation risk!). Provide a custom 'cloneState' function.");
        // If even JSON fails, return original as last resort, but warn heavily.
        return state;
    }
};