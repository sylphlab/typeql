// Import ServerDelta type from shared package now
import type { OptimisticSyncCoordinator as CoordinatorBase } from './coordinator'; // Assuming coordinator exists
import type { ServerDelta } from '@sylphlab/zen-query-shared'; // Import ServerDelta from shared
// Import functions from atomRegistry instead of type/creator
import { getAtom } from './utils/atomRegistry';
import type { AtomKey } from './utils/atomRegistry'; // Import AtomKey
import type { Atom } from 'nanostores';
import type { Patch } from 'immer'; // Assuming immer for patches
import type { Operation as PatchOperation } from 'fast-json-patch'; // Import PatchOperation

// Placeholder for Operation type based on error message
type Operation = PatchOperation; // TODO: Define this properly - Using PatchOperation

// Extend the base coordinator type with expected event handlers based on guidelines/errors
// TODO: Verify these against the actual implementation in './coordinator'
interface OptimisticSyncCoordinator extends CoordinatorBase {
    onStateChange(callback: () => void): () => void;
    onApplyDelta(callback: (delta: ServerDelta) => void): () => void;
    onRollback(callback: (inversePatchesByAtom: Map<string, Patch[]>) => void): () => void; // Use Patch[]
    // Add new event signatures
    onAck(callback: (clientSeq: number, result?: any) => void): () => void;
    onError(callback: (clientSeq: number, error: any) => void): () => void;

    processServerDelta(delta: ServerDelta): void;
    // Update signatures to match implementation
    rejectMutation(clientSeq: number, error?: any): void;
    confirmMutation(clientSeq: number, result?: any): void; // Added result param
    generateClientSeq(): number;
    // Updated signatures to use AtomKey and Operation (PatchOperation)
    registerPendingMutation(clientSeq: number, patchesByAtom: Map<AtomKey, Operation[]>, inversePatchesByAtom: Map<AtomKey, Operation[]>): void;
    // Use string keys based on errors in binding helpers - Kept string for now based on previous errors, revisit if needed
    // Correct return type based on TS error
    // Correct return type based on coordinator implementation - Updated return type
    getPendingPatches(): Map<AtomKey, Operation[]>;
}
// Assume the constructor exists on the base type
declare const OptimisticSyncCoordinator: {
    new (config?: any): OptimisticSyncCoordinator;
};


// --- Placeholder Types ---

// Placeholder for Transport interface
interface Transport {
  // Method to send messages to the server
  send: (message: ClientMessage) => void;
  // Method to register a listener for messages from the server
  // The callback should handle different message types
  onMessage: (callback: (message: ServerMessage) => void) => () => void; // Returns an unsubscribe function
  // Optional: Method to close the transport connection
  close?: () => void;
}

// Placeholder for Server Messages
type ServerMessage = ServerAckMessage | ServerDeltaMessage | ServerErrorMessage | ServerSubscriptionDataMessage;

interface ServerAckMessage {
  type: 'ack';
  clientSeq: number;
  // Potentially include serverSeq if needed for ordering guarantees
}

// Placeholder: Define ServerDelta structure (e.g., using JSON Patch)
// Remove local alias, use imported type from coordinator
// type ServerDelta = Patch[];

// Export this type for use in binding helpers
export interface ServerDeltaMessage {
  type: 'delta';
  /** Unique sequence number from the server for this delta */
  serverSeq: number;
  /** The sequence number of the delta this one follows (for ordering) */
  prevServerSeq?: number;
  /** The actual data changes */
  data: ServerDelta;
  /** Identifier for the specific query/subscription this delta applies to */
  key: string; // e.g., "query:user:1" or "sub:posts"
}

interface ServerErrorMessage {
  type: 'error';
  clientSeq?: number; // If the error relates to a specific mutation
  message: string;
  // Optional: error code, details
}

// Placeholder for initial subscription data or subsequent stream data
interface ServerSubscriptionDataMessage {
    type: 'subscriptionData';
    /** Identifier for the specific subscription */
    key: string;
    /** The sequence number from the server for this message (optional for initial) */
    serverSeq?: number;
    /** The actual data payload (full snapshot or delta) */
    // Use imported ServerDelta type
    data: any | ServerDelta; // Could be full state or a patch
    /** Flag indicating if this is the initial snapshot */
    isInitial?: boolean;
}


// Placeholder for Client Messages
// Corrected type name for subscription message
type ClientMessage = ClientQueryMessage | ClientMutationMessage | ClientSubscribeMessage | ClientUnsubscribeMessage;

interface ClientQueryMessage {
  type: 'query';
  path: string;
  input: any;
  // Optional: client-generated ID for correlating responses if transport is stateless
  // requestId?: string;
}

interface ClientMutationMessage {
  type: 'mutation';
  path: string;
  input: any;
  clientSeq: number; // Include client sequence number for optimistic updates
}

// Corrected type name
interface ClientSubscribeMessage {
  type: 'subscribe';
  path: string;
  input: any;
  // Optional: client-generated ID for correlating responses
  // subscriptionId?: string;
}

interface ClientUnsubscribeMessage {
    type: 'unsubscribe';
    path: string; // Or use subscriptionId if generated
    input: any; // Include input to uniquely identify the subscription instance
    // subscriptionId?: string;
}


// Placeholder for Delta Applicator function type
// It needs to know how to apply a delta (e.g., JSON Patch) to the specific state atom
// Use imported ServerDelta type
type DeltaApplicator = (atomKey: string, currentState: any, delta: ServerDelta) => any; // Returns the new state

// --- Client Options ---

export interface ClientOptions {
  transport: Transport;
  conflictResolverConfig?: any; // Placeholder for conflict resolution config
  deltaApplicator?: DeltaApplicator; // Optional: If not provided, coordinator might emit event
}

// --- Client Implementation ---

// Placeholder for the actual client implementation details
interface ZenQueryClientInternal {
  coordinator: OptimisticSyncCoordinator;
  // Remove atomRegistry instance, use exported functions
  // atomRegistry: AtomRegistry;
  transport: Transport;
  deltaApplicator?: DeltaApplicator;
}

// Placeholder for the structure returned by client.mutation
// This will be implemented using a Proxy
interface MutationProcedures {
  [key: string]: (input: any) => Promise<any>; // Simplified: returns promise, actual might involve optimistic state
}

// Placeholder for the structure returned by client.query
// This will be implemented using a Proxy
interface QueryProcedures {
  [key: string]: (input: any) => Promise<any>; // Simplified: returns promise
}

// Placeholder for the structure returned by client.subscription
// This will be implemented using a Proxy
interface SubscriptionProcedures {
  [key: string]: (input: any, callbacks: any) => { unsubscribe: () => void }; // Placeholder callbacks
}


/**
 * Defines the public interface of the ZenQueryClient.
 * Provides access to procedures and internal components needed by binding helpers.
 */
export interface ZenQueryClient {
  /** Access the internal OptimisticSyncCoordinator instance. */
  getCoordinator(): OptimisticSyncCoordinator;

  // Remove getAtomRegistry, use exported functions
  // /** Access the internal AtomRegistry instance. */
  // getAtomRegistry(): AtomRegistry;

  /** Access mutation procedures via a proxy. */
  mutation: MutationProcedures;

  /** Access query procedures via a proxy. */
  query: QueryProcedures;

  /** Access subscription procedures via a proxy. */
  subscription: SubscriptionProcedures;

  /** Closes the underlying transport connection, if available. */
  close?(): void;

  // Internal reference (conceptual, might not be directly exposed)
  // __internal: ZenQueryClientInternal;
}

/**
 * Creates a new ZenQuery client instance.
 *
 * @param options Configuration options for the client.
 * @returns The ZenQuery client instance.
 */
export function createClient(options: ClientOptions): ZenQueryClient {
  const { transport, conflictResolverConfig, deltaApplicator } = options; // Removed _coordinatorInstance

  // 1. Instantiate Coordinator
  // TODO: Pass conflictResolverConfig to the coordinator constructor when implemented
  const coordinator = new OptimisticSyncCoordinator(/* conflictResolverConfig */); // Reverted to direct instantiation

  // 2. Atom Registry is managed via imported functions, no instantiation needed
  // const atomRegistry = createAtomRegistry();

  // Internal state holder
  const internal: ZenQueryClientInternal = {
    coordinator,
    // Remove atomRegistry instance
    // atomRegistry,
    transport,
    deltaApplicator,
  };

  // 3. Transport Integration
  const unsubscribeTransport = transport.onMessage((message: ServerMessage) => {
    switch (message.type) {
      case 'ack':
        internal.coordinator.confirmMutation(message.clientSeq);
        break;
      case 'delta':
        // TODO: Refine how deltaApplicator is used - maybe coordinator emits event?
        // For now, assume coordinator handles it internally or via passed function
        if (internal.deltaApplicator) {
            // This assumes processServerDelta uses the applicator internally
            // OR that the applicator is passed differently. Adjust as needed.
             // Pass the full ServerDelta object (message.data), which now includes the key,
             // to the coordinator. The coordinator will emit this in onApplyDelta.
             internal.coordinator.processServerDelta(message.data);
        } else {
            // If no applicator, coordinator might emit 'onApplyDelta' event
            // Binding helpers would listen to that event.
            // Pass the full ServerDelta object (message.data), which now includes the key,
            // to the coordinator. The coordinator will emit this in onApplyDelta.
            internal.coordinator.processServerDelta(message.data);
            // Warning remains valid if no binding helper handles the onApplyDelta event
            // console.warn("Delta received but no deltaApplicator configured on client.", { key: message.key, delta: message.data });
        }
        break;
      case 'error':
        if (message.clientSeq) {
          // Pass only clientSeq and error as per guideline/placeholder interface
          internal.coordinator.rejectMutation(message.clientSeq, message.message);
        } else {
          // Handle global server errors (e.g., connection issues, auth errors)
          // TODO: Need a mechanism to propagate global errors (e.g., coordinator event)
          console.error('Received global server error:', message.message);
        }
        break;
      case 'subscriptionData':
         // TODO: How should raw subscription data be handled?
         // Option 1: Coordinator processes it like a delta (if it's a patch)
         // Option 2: Emit an event for binding helpers to handle directly
         // Option 3: Route to a specific handler based on message.key
         console.log('Received subscription data:', message);
         // Placeholder: Find the relevant atom using the imported getAtom function
         const targetAtom = getAtom(message.key);
         if (targetAtom) {
             if (message.isInitial) {
                 // Handle initial snapshot
                 // targetAtom.set(message.data); // Assuming data is full state
             } else {
                 // Handle subsequent delta/data
                 if (internal.deltaApplicator && Array.isArray(message.data)) { // Assuming delta is Patch[]
                    // const currentState = targetAtom.get();
                    // const newState = internal.deltaApplicator(message.key, currentState, message.data);
                    // targetAtom.set(newState);
                 } else {
                    // targetAtom.set(message.data); // Assume full state update if not delta
                 }
             }
             console.warn("Subscription data handling needs refinement based on Atom structure and delta/snapshot strategy.");

         } else {
             console.warn(`Received subscription data for unknown key: ${message.key}`);
         }
         break;
      default:
        console.warn('Received unknown message type from server:', message);
    }
  });

  // 4. Client API Proxy Implementation
  const PROCEDURE_MARKER = '_isZenQueryProcedure'; // Marker for procedure endpoints

  const internalState = internal; // Alias for use inside proxy

  const createRecursiveProxy = (currentPath: string[] = []): any => {
    // Target object can store non-proxied methods like getCoordinator
    const target = {
        getCoordinator: () => internalState.coordinator,
        close: () => {
            unsubscribeTransport(); // Unsubscribe from transport messages
            if (internalState.transport.close) {
                internalState.transport.close(); // Close connection if method exists
            }
            // TODO: Add any other cleanup (e.g., clear coordinator state?)
            // Consider adding a coordinator.reset() method if needed.
            console.log("ZenQuery client closed.");
        }
        // Add other non-proxied methods if needed
    };

    return new Proxy(target, {
      get(target, prop: string | symbol, receiver) {
        // Handle direct access to non-proxied methods
        if (prop in target) {
            // @ts-ignore - Allow indexing target
            return target[prop];
        }

        // Ignore symbols and promise 'then'
        if (typeof prop === 'symbol' || prop === 'then') {
          return undefined;
        }

        const newPath = [...currentPath, prop];
        const pathString = newPath.join('.');

        // Check if this path corresponds to a known procedure type endpoint
        // This is a simplified check; a real implementation might need more robust detection
        // or rely on the structure returned by the actual procedure implementations.
        // For now, we assume the binding helpers will access the final methods.
        // The key is to return the path *before* the final method access.

        // Let's simulate the expected structure for binding helpers:
        // client.posts.get -> returns proxy for 'posts.get'
        // client.posts.get.query -> returns { path: 'posts.get', procedure: { query: func }, _isZenQueryProcedure: true }

        // We need a way to know when we've reached the level *before* query/mutate/subscribe
        // Let's assume the actual procedures are attached at the level the binding helpers expect.
        // The proxy will intercept access up to that level.

        // Modified approach: The proxy intercepts access. When a binding helper calls
        // e.g., selector().procedure.query(), the proxy on 'procedure' needs to return
        // the final object. Let's refine the structure.

        // Create the actual procedure executor functions (similar to before, but using pathString)
        const procedureExecutors = {
            query: (input: any, opts?: { signal?: AbortSignal }) => {
                internal.transport.send({ type: 'query', path: pathString, input });
                // TODO: Return promise resolving with query result
                console.log(`[Proxy] Executing query for ${pathString}`);
                return Promise.resolve({ data: `Result for ${pathString}` }); // Placeholder
            },
            mutate: (input: any) => { // Assuming input object structure for mutate
                const clientSeq = internal.coordinator.generateClientSeq();
                // TODO: Integrate with binding helpers for optimistic updates BEFORE sending
                internal.transport.send({ type: 'mutation', path: pathString, input, clientSeq });
                 console.log(`[Proxy] Executing mutation for ${pathString}`);
                // TODO: Return promise resolving/rejecting based on Ack/Error
                return Promise.resolve({ ack: clientSeq }); // Placeholder
            },
            subscribe: (input: any, callbacks: any) => {
                internal.transport.send({ type: 'subscribe', path: pathString, input });
                 console.log(`[Proxy] Executing subscription for ${pathString}`);
                // TODO: Manage subscription lifecycle and callbacks
                return {
                    unsubscribe: () => {
                        internal.transport.send({ type: 'unsubscribe', path: pathString, input });
                        console.log(`[Proxy] Unsubscribing from ${pathString}`);
                    }
                };
            }
        };

        // Check if the *next* property access would be query/mutate/subscribe
        // This requires looking ahead, which proxies don't easily do.
        // Alternative: Return an object that *looks like* the procedure endpoint,
        // but its properties (query/mutate/subscribe) trigger the final return.

        return new Proxy({}, {
             get(_target2, method: string | symbol, _receiver2) {
                 if (typeof method === 'string' && (method === 'query' || method === 'mutate' || method === 'subscribe')) {
                     // This is the final access, return the special object
                     const procedure = { [method]: (procedureExecutors as any)[method] };
                     return {
                         path: pathString,
                         procedure: procedure,
                         [PROCEDURE_MARKER]: true,
                     };
                 }
                 // If accessing something else on this level (e.g., nested procedures like client.admin.users.list), continue recursion
                 if (typeof method === 'string') {
                     return createRecursiveProxy([...newPath, method]);
                 }
                 return undefined;
             }
        });

        // Original recursive call - replaced by the proxy above
        // return createRecursiveProxy(newPath);
      }
    });
  };


  // The client *is* the proxy
  const client = createRecursiveProxy([]);

  // Cast to ZenQueryClient for external type safety, acknowledging it's a proxy
  return client as ZenQueryClient;
}
