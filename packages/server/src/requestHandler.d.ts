import type { AnyRouter, ProcedureContext } from '@sylphlab/zen-query-shared';
import { SubscriptionManager } from './subscriptionManager';
import type { zenQueryTransport, ProcedureResultMessage, UnsubscribeMessage } from '@sylphlab/zen-query-shared';
/** Represents an incoming procedure call */
export interface ProcedureCall {
    /** Path to the procedure (e.g., 'user.get' or 'item.list') */
    path: string;
    /** Input data for the procedure */
    input?: unknown;
    /** Type of procedure */
    type: 'query' | 'mutation' | 'subscription';
    /** Unique ID for correlation, originates from client request/subscription */
    id: number | string;
}
/** Represents the result of a query or mutation call */
export interface ProcedureResult {
    /** The data returned by the procedure */
    data?: unknown;
    /** Error information, if any */
    error?: {
        message: string;
        code?: string;
    };
}
export interface RequestHandlerOptions<TContext extends ProcedureContext> {
    router: AnyRouter;
    /** Global subscription manager instance (shared across handlers/connections). */
    subscriptionManager: SubscriptionManager;
    /** Function to create context for each request */
    createContext: (opts: {
        transport: zenQueryTransport;
    }) => Promise<TContext> | TContext;
    /** Optional: Unique identifier for this specific client connection (e.g., from WebSocket server). */
    clientId?: string;
}
/**
 * Creates a function that handles incoming procedure calls against a specific router.
 *
 * @param opts Options including the router and context creation function.
 * @returns An async function that handles a ProcedureCall. For subscriptions, the return might differ or trigger side effects.
 */
/**
 * Creates a request handler object bound to a specific client transport.
 * This object contains a function to process incoming messages and a cleanup function.
 */
export interface RequestHandler {
    /** Processes an incoming message or an array of messages for batching. */
    handleMessage: (message: ProcedureCall | UnsubscribeMessage | ProcedureCall[]) => Promise<ProcedureResultMessage | ProcedureResultMessage[] | void>;
    /** Cleans up all resources associated with this handler (e.g., subscriptions). */
    cleanup: () => void;
}
export declare function createRequestHandler<TContext extends ProcedureContext>(opts: RequestHandlerOptions<TContext>, transport: zenQueryTransport): RequestHandler;
//# sourceMappingURL=requestHandler.d.ts.map