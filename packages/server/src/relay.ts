import * as z from 'zod';
// ProcedureBuilder class is not exported, it will be accessed via `this` in the .relay() method added to it.
// We import types needed for the builder's methods and generics.
import type { ProcedureOptions, Resolver } from './procedure'; // Import necessary types
import type { ProcedureContext, BaseProcedureDef } from '@sylphlab/zen-query-shared'; // Import shared types

// --- Relay Specific Schemas ---

// Base object for merging
const RelayArgsObjectSchema = z.object({
  first: z.number().int().min(0).optional(),
  after: z.string().optional(),
  last: z.number().int().min(0).optional(),
  before: z.string().optional(),
});

// Refined schema for validation
export const RelayArgsSchema = RelayArgsObjectSchema.refine(args => !(args.first && args.last), {
  message: "Cannot specify both `first` and `last`",
}).refine(args => !(args.after && args.before), {
  message: "Cannot specify both `after` and `before`",
});

export type RelayArgs = z.infer<typeof RelayArgsSchema>; // Infer from the refined schema

export const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  hasPreviousPage: z.boolean(),
  startCursor: z.string().nullable(),
  endCursor: z.string().nullable(),
});

export type PageInfo = z.infer<typeof PageInfoSchema>;

// Helper to create Edge schema dynamically
export const createEdgeSchema = <TNodeSchema extends z.ZodTypeAny>(nodeSchema: TNodeSchema) => {
  return z.object({
    cursor: z.string(),
    node: nodeSchema,
  });
};

// Helper to create Connection schema dynamically
export const createConnectionSchema = <TNodeSchema extends z.ZodTypeAny>(nodeSchema: TNodeSchema) => {
  const EdgeSchema = createEdgeSchema(nodeSchema);
  return z.object({
    edges: z.array(EdgeSchema),
    pageInfo: PageInfoSchema,
  });
};

// --- Relay Query Builder ---

// Placeholder type for the function users provide to fetch nodes
// Needs refinement in .relayResolve() implementation
// Type for the function users provide to fetch nodes
type FetchNodesFn<TContext, TFilterInput, TNodeOutput> = (
    args: { filters: TFilterInput; relay: RelayArgs; ctx: TContext }
) => Promise<{ nodes: TNodeOutput[]; pageInfo?: Partial<PageInfo>; /* maybe totalCount? */ }>;


export class RelayQueryBuilder<
    TContext = ProcedureContext,
    TFilterInputSchema extends z.ZodTypeAny | undefined = undefined, // User-defined filters
    TNodeOutputSchema extends z.ZodTypeAny | undefined = undefined, // Schema for the individual node
    // Internal types derived from schemas
    _TFilterInput = TFilterInputSchema extends z.ZodTypeAny ? z.infer<TFilterInputSchema> : unknown,
    _TNodeOutput = TNodeOutputSchema extends z.ZodTypeAny ? z.infer<TNodeOutputSchema> : unknown,
    _TCombinedInput = TFilterInputSchema extends z.ZodTypeAny ? z.infer<TFilterInputSchema> & RelayArgs : RelayArgs, // Combined input type
    _TConnectionOutput = TNodeOutputSchema extends z.ZodTypeAny ? z.infer<ReturnType<typeof createConnectionSchema<TNodeOutputSchema>>> : unknown // Final connection output type
> {
    // Store the base builder instance passed from the .relay() method
    // Type is complex, using 'any' for now, relying on instantiation for correctness.
    protected baseBuilder: any; // TODO: Refine type if possible, maybe InstanceType<typeof ProcedureBuilder> if exported
    protected filterSchema: TFilterInputSchema;
    protected nodeSchema: TNodeOutputSchema;

    // Internal definition state, similar to base ProcedureBuilder
    protected _def: Partial<BaseProcedureDef & {
        inputSchema?: z.ZodTypeAny;
        outputSchema?: z.ZodTypeAny;
        // Relay-specific additions might go here if needed
    }>;


    // Constructor takes the *base* query builder instance and schemas
    constructor(
        baseBuilderInstance: any, // Instance passed from ProcedureBuilder.relay()
        filterSchema?: TFilterInputSchema,
        nodeSchema?: TNodeOutputSchema
    ) {
        this.baseBuilder = baseBuilderInstance;
        this.filterSchema = filterSchema as TFilterInputSchema;
        this.nodeSchema = nodeSchema as TNodeOutputSchema;
        // Initialize internal def based on the base builder's def
        this._def = { ...baseBuilderInstance._def };
    }

    /**
     * Define the input filter schema (excluding Relay args).
     * Merges with RelayArgsSchema internally.
     * Requires the filter schema to be a ZodObject.
     */
    input<ZodFilterSchema extends z.AnyZodObject>( // Constraint added: must be an object
        schema: ZodFilterSchema
    ): RelayQueryBuilder<TContext, ZodFilterSchema, TNodeOutputSchema> {
        console.log(`[zenQuery Relay] Defining input filter schema...`);

        // Combine the user's filter schema with the *base* Relay arguments object
        const combinedObjectSchema = RelayArgsObjectSchema.merge(schema);
        // Apply refinements to the combined schema
        const combinedSchema = combinedObjectSchema.refine(args => !(args.first && args.last), {
            message: "Cannot specify both `first` and `last`",
        }).refine(args => !(args.after && args.before), {
            message: "Cannot specify both `after` and `before`",
        });


        // Update the base builder's input schema using the fully refined combined schema
        const nextBaseBuilder = this.baseBuilder.input(combinedSchema);

        // Return a new RelayQueryBuilder instance with updated types/schemas
        return new RelayQueryBuilder<TContext, ZodFilterSchema, TNodeOutputSchema>(
            nextBaseBuilder,
            schema, // Store the original filter schema
            this.nodeSchema
        );
    }


    /**
     * Define the output node schema.
     * Creates the Connection schema internally.
     */
    output<ZodNodeSchema extends z.ZodTypeAny>(
        schema: ZodNodeSchema
    ): RelayQueryBuilder<TContext, TFilterInputSchema, ZodNodeSchema> {
        console.log(`[zenQuery Relay] Defining output node schema...`);

        // Create the connection schema based on the node schema
        const connectionSchema = createConnectionSchema(schema);

        // Update the base builder's output schema
        const nextBaseBuilder = this.baseBuilder.output(connectionSchema);

        // Return a new RelayQueryBuilder instance with updated types/schemas
        return new RelayQueryBuilder<TContext, TFilterInputSchema, ZodNodeSchema>(
            nextBaseBuilder,
            this.filterSchema,
            schema // Store the node schema
        );
    }


    /**
     * Define the resolver function that fetches nodes based on filters and Relay args.
     */
    relayResolve(
        // User provides a function to fetch nodes based on filters and relay args
        fetchNodesFn: FetchNodesFn<TContext, _TFilterInput, _TNodeOutput>
    ): { _def: BaseProcedureDef } { // Return type matches base builder's resolve
        console.log(`[zenQuery Relay] Defining relay resolver...`);

        if (!this.nodeSchema) {
            throw new Error("Output node schema must be defined using .output() before calling .relayResolve()");
        }
        if (!this.baseBuilder._def.inputSchema) {
             // Should not happen if .input() was called or if no filterSchema was provided
             console.warn("[zenQuery Relay] Input schema not found on base builder. Assuming only RelayArgs.");
        }

        // Define the final resolver that the base builder will use
        const finalResolver: Resolver<_TCombinedInput, _TConnectionOutput, TContext> = async (opts) => {
            // 1. Extract filters and relay args from the combined input
            // We rely on the structure defined by the .input() method
            // Cast to a more flexible type to access properties safely
            const combinedInput = opts.input as Record<string, unknown>;
            const relayArgs: RelayArgs = {
                first: combinedInput.first as number | undefined,
                after: combinedInput.after as string | undefined,
                last: combinedInput.last as number | undefined,
                before: combinedInput.before as string | undefined,
            };
            // Create a filters object excluding the relay args
            const filters = { ...combinedInput };
            delete filters.first;
            delete filters.after;
            delete filters.last;
            delete filters.before;


            // 2. Call the user's function with separated arguments
            const { nodes, pageInfo: fetchedPageInfoPart } = await fetchNodesFn({
                // Cast the cleaned filters object to the expected type
                filters: filters as _TFilterInput,
                relay: relayArgs,
                ctx: opts.ctx,
            });

            // 3. Use the placeholder (or real) buildConnection logic
            // Pass fetched nodes and the extracted relay args
            const connection = buildConnection(nodes, relayArgs, fetchedPageInfoPart);

            // 4. Return the fully formed Connection object
            // Type assertion might be needed if _TConnectionOutput isn't perfectly inferred
            return connection as _TConnectionOutput;
        };

        // Call the base builder's resolve method with our constructed resolver
        return this.baseBuilder.resolve(finalResolver);
    }

}


// Helper function for Base64 encoding (simple implementation)
const encodeCursor = (value: string): string => {
    try {
        // Use Buffer in Node.js environment if available
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(value).toString('base64');
        }
        // Fallback for environments without Buffer (like some edge runtimes or browsers without polyfill)
        // Note: btoa might not handle all Unicode characters correctly
        return btoa(unescape(encodeURIComponent(value))); // Handle potential UTF-8 issues with btoa
    } catch (e) {
        console.error("Failed to encode cursor:", e);
        return value; // Fallback to unencoded value
    }
};


/**
 * Builds a Relay connection object from a slice of nodes and arguments.
 * Assumes the `nodes` array might contain one extra item than requested
 * (if `first` or `last` was used) to determine pagination existence.
 */
function buildConnection<TNode>(
    nodes: TNode[],
    args: RelayArgs,
    fetchedPageInfoPart?: Partial<PageInfo> // Allow user to provide parts of pageInfo
): { edges: { node: TNode; cursor: string }[]; pageInfo: PageInfo } {
    let slicedNodes = [...nodes]; // Create a mutable copy
    let hasNextPage = fetchedPageInfoPart?.hasNextPage ?? false;
    let hasPreviousPage = fetchedPageInfoPart?.hasPreviousPage ?? false;

    // --- Determine pagination based on fetched count vs. args ---
    if (args.first !== undefined && nodes.length > args.first) {
        hasNextPage = true;
        slicedNodes = slicedNodes.slice(0, args.first); // Remove the extra node used for detection
    }
    if (args.last !== undefined && nodes.length > args.last) {
        hasPreviousPage = true;
        slicedNodes = slicedNodes.slice(nodes.length - args.last); // Take the last 'last' nodes
    }

    // --- Further refine pagination based on cursors ---
    // If 'after' is present, we definitely have a previous page (unless it's the *very* first item, which is hard to know here)
    if (args.after !== undefined) {
        hasPreviousPage = true;
    }
     // If 'before' is present, we definitely have a next page (unless it's the *very* last item)
    if (args.before !== undefined) {
        hasNextPage = true;
    }

    // --- Create Edges with Cursors ---
    const edges = slicedNodes.map((node, index) => {
        // TODO: Replace index-based cursor with a more stable one (e.g., based on node ID)
        const cursorValue = `cursor:${index}`; // Simple prefix + index
        return {
            node,
            cursor: encodeCursor(cursorValue),
        };
    });

    // --- Construct Final PageInfo ---
    const pageInfo: PageInfo = {
        hasNextPage,
        hasPreviousPage,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges[edges.length - 1]?.cursor ?? null,
    };

    console.log(`Built connection with ${edges.length} edges. PageInfo:`, pageInfo);

    return { edges, pageInfo };
}


console.log("packages/server/src/relay.ts loaded");