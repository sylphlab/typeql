import type {
  AtomKey,
  AtomRegistry,
  QueryAtom,
  SubscriptionAtom,
} from '../types';

/**
 * Placeholder implementation for the Atom Registry.
 * In a real scenario, this might use WeakRefs or a more robust mechanism
 * to manage atom lifecycles and prevent memory leaks.
 */
export function createAtomRegistry(): AtomRegistry {
  const queryAtoms = new Map<AtomKey, QueryAtom>();
  const subscriptionAtoms = new Map<AtomKey, SubscriptionAtom>();

  return {
    registerQueryAtom(key, atom) {
      // TODO: Add checks for duplicate keys? Or allow replacement?
      queryAtoms.set(key, atom);
      console.log(`[AtomRegistry] Registered query atom:`, key);
    },
    registerSubscriptionAtom(key, atom) {
      // TODO: Add checks for duplicate keys?
      subscriptionAtoms.set(key, atom);
      console.log(`[AtomRegistry] Registered subscription atom:`, key);
    },
    getQueryAtom(key) {
      return queryAtoms.get(key);
    },
    getSubscriptionAtom(key) {
      return subscriptionAtoms.get(key);
    },
    // TODO: Implement unregister methods
    // unregisterQueryAtom(key) { ... }
    // unregisterSubscriptionAtom(key) { ... }
  };
}

// Potential: Create a default global registry instance?
// export const globalAtomRegistry = createAtomRegistry();
// Or should it be tied to the client instance? Likely tied to client.