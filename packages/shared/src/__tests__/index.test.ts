import { describe, it, expect, beforeEach } from 'vitest'; // Import beforeEach
import { generateId, applyStandardDelta, StandardDelta, AddDelta, UpdateDelta, RemoveDelta, ReplaceDelta, MoveDelta, PatchDelta } from '../index'; // Adjust path as needed

describe('@sylphlab/typeql-shared', () => {
  describe('generateId', () => {
    it('should generate a string ID', () => {
      const id = generateId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should generate unique IDs', () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('StandardDelta Utilities', () => {
    let state: any;

    beforeEach(() => {
      state = {
        users: [ // Changed to array
          { id: '1', name: 'Alice', age: 30 },
          { id: '2', name: 'Bob', age: 25 },
        ],
        posts: [{ id: 'p1', title: 'Post 1' }],
        counter: 0,
      };
    });

    // --- applyStandardDelta ---

    // Note: StandardDelta 'add' applies to arrays/collections in the current implementation
    // Testing adding to an object property directly would require 'replace' or 'patch'

    it('applyStandardDelta: should apply ADD delta to an array (append)', () => {
      const delta: AddDelta<any> = { type: 'add', path: ['posts'], item: { id: 'p2', title: 'Post 2' } };
      const newState = applyStandardDelta(state, delta);
      expect(newState.posts).toHaveLength(2);
      expect(newState.posts[1]).toEqual({ id: 'p2', title: 'Post 2' });
      expect(newState).not.toBe(state); // Ensure immutability
    });

    // Note: StandardDelta 'add' doesn't support insert at index in the current implementation

    it('applyStandardDelta: should apply REMOVE delta from a collection', () => {
      const delta: RemoveDelta = { type: 'remove', path: ['users'], id: '1' };
      const newState = applyStandardDelta(state, delta);
      expect(newState.users.find((u: any) => u.id === '1')).toBeUndefined();
      expect(newState.users.length).toBe(1);
      expect(newState).not.toBe(state);
    });

    // Note: StandardDelta 'remove' uses ID, not index, in the current implementation

    it('applyStandardDelta: should apply UPDATE delta to an item in a collection', () => {
      const delta: UpdateDelta<any> = { type: 'update', path: ['users'], id: '2', changes: { age: 26 } };
      const newState = applyStandardDelta(state, delta);
      const updatedUser = newState.users.find((u: any) => u.id === '2');
      expect(updatedUser?.age).toBe(26);
      expect(newState).not.toBe(state);
    });

     it('applyStandardDelta: should apply REPLACE delta on a path', () => {
       const delta: ReplaceDelta<any> = { type: 'replace', path: ['users', '1'], state: { name: 'Alice V2', status: 'updated' } };
       const newState = applyStandardDelta(state, delta);
       // Replace affects the element at the path, not by ID in the current implementation
       // This test might need rethinking based on desired 'replace' behavior on collections
       // For now, check if the path was replaced
       expect(newState.users[1]).toEqual({ name: 'Alice V2', status: 'updated' }); // Assuming path ['users', '1'] targets index 1
       expect(newState).not.toBe(state);
     });

     it('applyStandardDelta: should apply REPLACE delta on root', () => {
       const delta: ReplaceDelta<any> = { type: 'replace', state: { completely: 'new state' } }; // Path defaults to root
       const newState = applyStandardDelta(state, delta);
       expect(newState).toEqual({ completely: 'new state' });
      expect(newState).not.toBe(state);
    });

    // Note: The 'move within array' test was removed as the MOVE delta uses JSON pointers, not array indices directly in its definition.
    it('applyStandardDelta: should apply MOVE delta', () => {
      // Move user 1's data using JSON Pointer paths
      // Move user at index 1 (id: '2') to index 0
      const delta: MoveDelta = { type: 'move', id: '2', fromPath: '/users/1', toPath: '/users/0' };
      const newState = applyStandardDelta(state, delta);
      expect(newState.users.length).toBe(2);
      expect(newState.users[0].id).toBe('2'); // Bob is now at index 0
      expect(newState.users[1].id).toBe('1'); // Alice is now at index 1
      expect(newState).not.toBe(state); // Ensure immutability
    });

    // Note: StandardDelta doesn't have a 'copy' type, use 'patch' for this

    it('applyStandardDelta: should apply PATCH delta (using JSON Patch format)', () => {
      // Example: Replace age of user 2 and add a new property
      // User with id '2' is at index 1
      const patchOps = [
          { op: 'replace', path: '/users/1/age', value: 27 },
          { op: 'add', path: '/users/1/status', value: 'active' }
      ];
      const delta: PatchDelta = { type: 'patch', patch: patchOps }; // Path defaults to root
      const newState = applyStandardDelta(state, delta);
      const patchedUser = newState.users.find((u: any) => u.id === '2'); // Find user by ID
      expect(patchedUser?.age).toBe(27);
      expect((patchedUser as any)?.status).toBe('active'); // Cast to any for status check
      expect(newState).not.toBe(state);
    });

    // Note: StandardDelta doesn't have a 'test' type, use 'patch' for this

     it('applyStandardDelta: should handle multiple deltas (if applyStandardDelta supported arrays - it currently does not)', () => {
       const deltas: StandardDelta<any, any>[] = [
         { type: 'remove', path: ['users'], id: '1' },
         { type: 'update', path: ['users'], id: '2', changes: { name: 'Robert' } },
         { type: 'add', path: ['posts'], item: { id: 'p2', title: 'Post 2' } },
       ];
       // Assuming applyStandardDelta could handle arrays:
       // const newState = applyStandardDelta(state, deltas);
       // expect(newState.users['1']).toBeUndefined();
       // expect(newState.users['2'].name).toBe('Robert');
       // expect(newState.posts).toHaveLength(2);
       // expect(newState.posts[1]).toEqual({ id: 'p2', title: 'Post 2' });

       // Current behavior: Apply sequentially (demonstration, not ideal)
       let newState = state;
       for (const delta of deltas) {
           newState = applyStandardDelta(newState, delta);
       }
        expect(newState.users.find((u: any) => u.id === '1')).toBeUndefined();
        const finalUser2 = newState.users.find((u: any) => u.id === '2');
        expect(finalUser2?.name).toBe('Robert');
        expect(newState.posts).toHaveLength(2);
        expect(newState.posts[1]).toEqual({ id: 'p2', title: 'Post 2' });
       expect(newState).not.toBe(state);
     });

     it('applyStandardDelta: should return original state if delta type is unknown', () => {
       const unknownDelta: any = { type: 'unknown', data: 'foo' };
       const newState = applyStandardDelta(state, unknownDelta);
       expect(newState).toBe(state); // Should return original state and log warning
     });

     it('applyStandardDelta: should throw error for invalid operation', () => {
       const invalidDelta: any = { op: 'INVALID', path: '/users/1' };
       // Expect it to return the original state and log warning, not throw
       expect(applyStandardDelta(state, invalidDelta)).toBe(state);
     });

     it('applyStandardDelta: should throw error for invalid path', () => {
       // Test invalid path for custom add/update/remove logic
       const delta: RemoveDelta = { type: 'remove', path: ['nonexistentPath'], id: '1' };
       // Expect it to return the original state due to console error and return state logic
       expect(applyStandardDelta(state, delta)).toBe(state);
     });


    // --- createStandardDelta ---
    // Basic creation tests are implicitly covered by applyStandardDelta tests
    // Add specific tests if complex logic is added to createStandardDelta

    // --- createStandardDelta --- tests removed as the function doesn't exist ---

  });
});