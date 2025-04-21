import { describe, it, expect, vi, beforeEach } from 'vitest'; // Add beforeEach
import * as z from 'zod';
import {
    RelayArgsSchema,
    PageInfoSchema,
    createEdgeSchema,
    createConnectionSchema,
    // buildConnection is not exported, test via RelayQueryBuilder or export it for testing
} from './relay';
import { initTypeQL } from './procedure'; // To test the builder chain

// --- Mock buildConnection for builder tests ---
// We need to access the internal function for direct testing or mock it.
// Let's assume we can import it for testing or test its effects through relayResolve.
// For now, let's mock it for the builder chain test.
const mockBuildConnection = vi.fn((nodes, args, fetchedPageInfoPart) => {
    console.log('mockBuildConnection called with:', nodes, args, fetchedPageInfoPart);
    const edges = nodes.map((node: any, index: number) => ({
        node,
        cursor: `mock-cursor-${index}`,
    }));
    return {
        edges,
        pageInfo: {
            hasNextPage: fetchedPageInfoPart?.hasNextPage ?? false,
            hasPreviousPage: fetchedPageInfoPart?.hasPreviousPage ?? false,
            startCursor: edges[0]?.cursor ?? null,
            endCursor: edges[edges.length - 1]?.cursor ?? null,
        },
    };
});

vi.mock('./relay', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./relay')>();
    return {
        ...actual,
        buildConnection: mockBuildConnection, // Mock buildConnection
    };
});


// --- Test Schemas ---
const NodeSchema = z.object({
    id: z.string(),
    value: z.number(),
});
type NodeType = z.infer<typeof NodeSchema>;

describe('Relay Schemas', () => {
    it('RelayArgsSchema should validate correct args', () => {
        expect(RelayArgsSchema.safeParse({ first: 10 }).success).toBe(true);
        expect(RelayArgsSchema.safeParse({ last: 5, before: 'abc' }).success).toBe(true);
        expect(RelayArgsSchema.safeParse({ first: 10, after: 'xyz' }).success).toBe(true);
    });

    it('RelayArgsSchema should reject invalid args', () => {
        expect(RelayArgsSchema.safeParse({ first: 10, last: 5 }).success).toBe(false);
        expect(RelayArgsSchema.safeParse({ after: 'abc', before: 'xyz' }).success).toBe(false);
        expect(RelayArgsSchema.safeParse({ first: -1 }).success).toBe(false);
    });

    it('createEdgeSchema should create a valid Zod schema', () => {
        const EdgeSchema = createEdgeSchema(NodeSchema);
        const result = EdgeSchema.safeParse({ cursor: 'c1', node: { id: 'a', value: 1 } });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.cursor).toBe('c1');
            expect(result.data.node.id).toBe('a');
        }
    });

    it('createConnectionSchema should create a valid Zod schema', () => {
        const ConnectionSchema = createConnectionSchema(NodeSchema);
        const result = ConnectionSchema.safeParse({
            edges: [{ cursor: 'c1', node: { id: 'a', value: 1 } }],
            pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: 'c1', endCursor: 'c1' },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.edges).toHaveLength(1);
            expect(result.data.pageInfo.hasNextPage).toBe(true);
        }
    });
});

// --- Test buildConnection (Directly, assuming it's exported or accessible) ---
// If buildConnection remains unexported, these tests need to be adapted
// to test through the relayResolve method.

/*
// Assuming buildConnection is exported for testing:
import { buildConnection } from './relay';

describe('buildConnection Logic', () => {
    const nodes: NodeType[] = [
        { id: 'a', value: 1 },
        { id: 'b', value: 2 },
        { id: 'c', value: 3 },
        { id: 'd', value: 4 },
        { id: 'e', value: 5 },
    ];

    // Helper to decode cursor for verification
    const decode = (cursor: string | null) => cursor ? Buffer.from(cursor, 'base64').toString('utf-8') : null;

    it('should handle empty nodes array', () => {
        const connection = buildConnection([], {});
        expect(connection.edges).toEqual([]);
        expect(connection.pageInfo).toEqual({
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
        });
    });

    it('should handle "first" argument correctly (hasNextPage=true)', () => {
        const connection = buildConnection(nodes, { first: 3 }); // nodes.length (5) > first (3)
        expect(connection.edges).toHaveLength(3);
        expect(connection.edges[0].node.id).toBe('a');
        expect(connection.edges[2].node.id).toBe('c');
        expect(decode(connection.edges[0].cursor)).toBe('cursor:0');
        expect(decode(connection.edges[2].cursor)).toBe('cursor:2');
        expect(connection.pageInfo.hasNextPage).toBe(true);
        expect(connection.pageInfo.hasPreviousPage).toBe(false); // No 'after' or 'last'
        expect(decode(connection.pageInfo.startCursor)).toBe('cursor:0');
        expect(decode(connection.pageInfo.endCursor)).toBe('cursor:2');
    });

     it('should handle "first" argument correctly (hasNextPage=false)', () => {
        const connection = buildConnection(nodes.slice(0, 3), { first: 3 }); // nodes.length (3) === first (3)
        expect(connection.edges).toHaveLength(3);
        expect(connection.pageInfo.hasNextPage).toBe(false);
        expect(connection.pageInfo.hasPreviousPage).toBe(false);
    });

    it('should handle "last" argument correctly (hasPreviousPage=true)', () => {
        const connection = buildConnection(nodes, { last: 3 }); // nodes.length (5) > last (3)
        expect(connection.edges).toHaveLength(3);
        expect(connection.edges[0].node.id).toBe('c'); // Sliced from end
        expect(connection.edges[2].node.id).toBe('e');
        // Note: Cursors are based on the *sliced* array index here
        expect(decode(connection.edges[0].cursor)).toBe('cursor:0'); // Index within the sliced array
        expect(decode(connection.edges[2].cursor)).toBe('cursor:2');
        expect(connection.pageInfo.hasNextPage).toBe(false); // No 'before' or 'first'
        expect(connection.pageInfo.hasPreviousPage).toBe(true);
        expect(decode(connection.pageInfo.startCursor)).toBe('cursor:0');
        expect(decode(connection.pageInfo.endCursor)).toBe('cursor:2');
    });

     it('should handle "last" argument correctly (hasPreviousPage=false)', () => {
        const connection = buildConnection(nodes.slice(2, 5), { last: 3 }); // nodes.length (3) === last (3)
        expect(connection.edges).toHaveLength(3);
        expect(connection.pageInfo.hasNextPage).toBe(false);
        expect(connection.pageInfo.hasPreviousPage).toBe(false);
    });

    it('should set hasPreviousPage=true with "after" argument', () => {
        const connection = buildConnection(nodes.slice(1, 4), { first: 3, after: 'some-cursor' });
        expect(connection.edges).toHaveLength(3);
        expect(connection.pageInfo.hasPreviousPage).toBe(true);
        // hasNextPage depends on whether an extra node was fetched
        expect(connection.pageInfo.hasNextPage).toBe(false); // Assuming exactly 3 nodes were passed
    });

     it('should set hasNextPage=true with "before" argument', () => {
        const connection = buildConnection(nodes.slice(1, 4), { last: 3, before: 'some-cursor' });
        expect(connection.edges).toHaveLength(3);
        expect(connection.pageInfo.hasNextPage).toBe(true);
        // hasPreviousPage depends on whether an extra node was fetched
        expect(connection.pageInfo.hasPreviousPage).toBe(false); // Assuming exactly 3 nodes were passed
    });

    it('should prioritize fetchedPageInfoPart', () => {
        const connection = buildConnection(nodes.slice(0, 3), { first: 3 }, { hasNextPage: true, hasPreviousPage: true });
        expect(connection.pageInfo.hasNextPage).toBe(true);
        expect(connection.pageInfo.hasPreviousPage).toBe(true);
    });
});
*/

// --- Test RelayQueryBuilder Chain ---

describe('RelayQueryBuilder Chain', () => {
    const t = initTypeQL<{ user?: string }>(); // Example context

    const FilterSchema = z.object({ search: z.string().optional() });
    type FilterType = z.infer<typeof FilterSchema>;

    // Remove generic types for now and use type assertion later if needed
    const mockFetchNodesFn = vi.fn();
    // We will rely on the mock implementation and call assertions to ensure correctness


    beforeEach(() => {
        vi.clearAllMocks();
        // Reset mock return value before each test
        mockFetchNodesFn.mockResolvedValue({ nodes: [] });
    });

    it('should build a relay query procedure and call resolver correctly', async () => {
        const node1: NodeType = { id: 'node1', value: 101 };
        const node2: NodeType = { id: 'node2', value: 102 };
        mockFetchNodesFn.mockResolvedValue({
            nodes: [node1, node2],
            pageInfo: { hasNextPage: true }
        });
        mockBuildConnection.mockReturnValue({ // Mock the return of the *mocked* buildConnection
             edges: [ { node: node1, cursor: 'mc1'}, { node: node2, cursor: 'mc2'} ],
             pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: 'mc1', endCursor: 'mc2'}
        });


        const relayProc = t.query
            .relay()
            .input(FilterSchema)
            .output(NodeSchema)
            // Add type assertion to resolve assignability issue
            .relayResolve(mockFetchNodesFn as any);

        // Simulate calling the resolver (internal detail, normally done by request handler)
        const resolver = relayProc._def.resolver;
        expect(resolver).toBeDefined();

        const inputArgs = { search: 'test', first: 2, after: 'abc' };
        const context = { user: 'tester' };

        const result = await resolver!({ input: inputArgs, ctx: context });

        // 1. Verify mockFetchNodesFn was called correctly
        expect(mockFetchNodesFn).toHaveBeenCalledTimes(1);
        expect(mockFetchNodesFn).toHaveBeenCalledWith({
            filters: { search: 'test' }, // Only filter args
            relay: { first: 2, after: 'abc', last: undefined, before: undefined }, // Only relay args
            ctx: context,
        });

        // 2. Verify mockBuildConnection was called correctly
        expect(mockBuildConnection).toHaveBeenCalledTimes(1);
        expect(mockBuildConnection).toHaveBeenCalledWith(
            [node1, node2], // Nodes returned by fetchNodesFn
            { first: 2, after: 'abc', last: undefined, before: undefined }, // Relay args extracted
            { hasNextPage: true } // pageInfoPart returned by fetchNodesFn
        );

        // 3. Verify the final result matches mockBuildConnection's return
        expect(result).toEqual({
             edges: [ { node: node1, cursor: 'mc1'}, { node: node2, cursor: 'mc2'} ],
             pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: 'mc1', endCursor: 'mc2'}
        });

        // 4. Verify schemas are set in the definition (optional check)
        expect(relayProc._def.inputSchema).toBeDefined();
        expect(relayProc._def.outputSchema).toBeDefined();
        // Check if the output schema is the connection schema
        const outputSchema = relayProc._def.outputSchema as z.ZodObject<any>;
        expect(outputSchema.shape.edges).toBeDefined();
        expect(outputSchema.shape.pageInfo).toBeDefined();

    });

     it('should handle relay query without input filters', async () => {
        const node1: NodeType = { id: 'node1', value: 101 };
        mockFetchNodesFn.mockResolvedValue({ nodes: [node1] });
         mockBuildConnection.mockReturnValue({
             edges: [ { node: node1, cursor: 'mc1'} ],
             pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'mc1', endCursor: 'mc1'}
        });

        // Omit .input()
        const relayProc = t.query
            .relay()
            // .input(FilterSchema) // No input filter
            .output(NodeSchema)
             // Add type assertion
            .relayResolve(mockFetchNodesFn as any);

        const resolver = relayProc._def.resolver;
        expect(resolver).toBeDefined();

        const inputArgs = { first: 1 }; // Only relay args
        const context = { user: 'tester' };

        await resolver!({ input: inputArgs, ctx: context });

        expect(mockFetchNodesFn).toHaveBeenCalledTimes(1);
        expect(mockFetchNodesFn).toHaveBeenCalledWith({
            filters: {}, // Empty filters object
            relay: { first: 1, after: undefined, last: undefined, before: undefined },
            ctx: context,
        });
         expect(mockBuildConnection).toHaveBeenCalledTimes(1);
         expect(mockBuildConnection).toHaveBeenCalledWith(
            [node1],
            { first: 1, after: undefined, last: undefined, before: undefined },
            undefined // No pageInfoPart returned
        );
    });

    it('should throw error if .output() is not called before .relayResolve()', () => {
        const builder = t.query.relay().input(FilterSchema);
         // Add type assertion
        expect(() => builder.relayResolve(mockFetchNodesFn as any)).toThrow(
            "Output node schema must be defined using .output() before calling .relayResolve()"
        );
   });

     it('should throw error if .relay() is called on mutation/subscription', () => {
        expect(() => t.mutation.relay()).toThrow(
            "'.relay()' can only be used for query procedures."
        );
         expect(() => t.subscription.relay()).toThrow(
            "'.relay()' can only be used for query procedures."
        );
    });

});