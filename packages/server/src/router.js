// packages/core/src/server/router.ts
/**
 * The main router class/object.
 * Holds the definition containing procedures and context type.
 */
// Use interface merging for AnyRouter if needed, or just use BaseRouter internally
class Router {
    // Expose the internal definition for type inference
    _def; // Use extended RouterDef
    constructor(def) {
        this._def = def;
    }
}
// --- Router Creation ---
// We don't need a complex builder like procedures initially.
// A simple function to define procedures is sufficient for now.
/**
 * Creates a TypeQL router.
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
export function createRouter() {
    console.log("[TypeQL Server] Router factory created.");
    return (procedures) => {
        console.log("[TypeQL Server] Defining router procedures...");
        // Ensure the definition conforms to the extended RouterDef
        const def = {
            router: true,
            procedures: procedures,
        };
        return new Router(def);
    };
}
// Example usage (for illustration)
/*
import { initTypeQL } from './procedure';
import * as z from 'zod';

interface MyContext extends ProcedureContext { isAdmin: boolean }
const t = initTypeQL<MyContext>();

const healthCheckProcedure = t.query.resolve(() => ({ status: 'ok', timestamp: Date.now() }));

const itemRouter = createRouter<MyContext>()({
  get: t.query
    .input(z.object({ id: z.string() }))
    .resolve(({ input }) => ({ id: input.id, name: `Item ${input.id}` })),
  list: t.query
    .resolve(() => [{ id: '1', name: 'Item 1' }, { id: '2', name: 'Item 2' }]),
});

const mainRouter = createRouter<MyContext>()({
  health: healthCheckProcedure,
  item: itemRouter, // Nested router
  adminOnly: t.query.resolve(({ ctx }) => {
    if (!ctx.isAdmin) throw new Error("Unauthorized");
    return { secret: 'data' };
  }),
});

// This is the type the client would import
export type AppRouter = typeof mainRouter;

// Verify types (compile-time check)
const procedures = mainRouter._def.procedures;
const itemProcedures = procedures.item._def.procedures;
const getItemInputSchema = itemProcedures.get._def.inputSchema; // Should exist and be Zod schema
*/
console.log("packages/core/src/server/router.ts loaded");
//# sourceMappingURL=router.js.map