import type { ProcedureContext, AnyRouter, ProcedureRouterRecord, BaseRouterDef } from '@sylphlab/zen-query-shared';
/** Internal definition of a router, extending the base */
export interface RouterDef<TContext extends ProcedureContext, TRecord extends ProcedureRouterRecord> extends BaseRouterDef {
    procedures: TRecord;
}
/**
 * The main router class/object.
 * Holds the definition containing procedures and context type.
 */
declare class Router<TContext extends ProcedureContext, TRecord extends ProcedureRouterRecord> implements AnyRouter {
    readonly _def: RouterDef<TContext, TRecord>;
    constructor(def: RouterDef<TContext, TRecord>);
}
/**
 * Creates a zenQuery router.
 * Define procedures directly within the passed object.
 *
 * @example
 * const userRouter = createRouter<MyContext>()({
 *   getUser: t.query.input(..).resolve(..),
 *   updateUser: t.mutation.input(..).resolve(..),
 * });
 *
 * const appRouter = createRouter<MyContext>()({
 *   user: userRouter, // Nest routers
 *   health: t.query.resolve(() => 'ok'),
 * });
 *
 * export type AppRouter = typeof appRouter; // Export type for client
 */
export declare function createRouter<TContext extends ProcedureContext>(): <TRecord extends ProcedureRouterRecord>(procedures: TRecord) => Router<TContext, TRecord>;
//# sourceMappingURL=router.d.ts.map