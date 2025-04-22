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
      // TODO: Add checks for duplicate keys? Or allow replacement? - Added warning
      if (queryAtoms.has(key)) {
        console.warn(`[AtomRegistry] Query atom already registered for key: ${String(key)}. Overwriting.`); // Use String()
      }
      queryAtoms.set(key, atom);
      console.log(`[AtomRegistry] Registered query atom:`, key);
    },
    registerSubscriptionAtom(key, atom) {
      // TODO: Add checks for duplicate keys? - Added warning
      if (subscriptionAtoms.has(key)) {
        console.warn(`[AtomRegistry] Subscription atom already registered for key: ${String(key)}. Overwriting.`); // Use String()
      }
      subscriptionAtoms.set(key, atom);
      console.log(`[AtomRegistry] Registered subscription atom:`, key);
    },
    getQueryAtom(key) {
      return queryAtoms.get(key);
    },
    getSubscriptionAtom(key) {
      return subscriptionAtoms.get(key);
     },
     // TODO: Implement unregister methods - Implemented
     unregisterQueryAtom(key: AtomKey) { // Add type
       const deleted = queryAtoms.delete(key);
       if (deleted) {
         console.log('[AtomRegistry] Unregistered query atom:', String(key)); // Use String()
       }
       return deleted;
     },
     unregisterSubscriptionAtom(key: AtomKey) { // Add type
       const deleted = subscriptionAtoms.delete(key);
       if (deleted) {
         console.log('[AtomRegistry] Unregistered subscription atom:', String(key)); // Use String()
      }
      return deleted;
    }
  };
}

// Potential: Create a default global registry instance?
// export const globalAtomRegistry = createAtomRegistry();
// Or should it be tied to the client instance? Likely tied to client.