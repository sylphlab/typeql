import * as z from 'zod';

// Base schema for common properties
const BaseOperationSchema = z.object({
  path: z.string().refine(val => val.startsWith('/'), {
    message: "JSON Patch path must start with '/'",
  }),
});

// Specific operation schemas
const AddOperationSchema = BaseOperationSchema.extend({
  op: z.literal('add'),
  value: z.any(), // Value can be anything
});

const RemoveOperationSchema = BaseOperationSchema.extend({
  op: z.literal('remove'),
});

const ReplaceOperationSchema = BaseOperationSchema.extend({
  op: z.literal('replace'),
  value: z.any(),
});

const MoveOperationSchema = BaseOperationSchema.extend({
  op: z.literal('move'),
  from: z.string().refine(val => val.startsWith('/'), {
    message: "JSON Patch 'from' path must start with '/'",
  }),
});

const CopyOperationSchema = BaseOperationSchema.extend({
  op: z.literal('copy'),
  from: z.string().refine(val => val.startsWith('/'), {
    message: "JSON Patch 'from' path must start with '/'",
  }),
});

const TestOperationSchema = BaseOperationSchema.extend({
  op: z.literal('test'),
  value: z.any(),
});

// Schema for the internal '_get' operation used by fast-json-patch compare
const GetOperationSchema = BaseOperationSchema.extend({
    op: z.literal('_get'), // Internal operation
    // It might not have other properties, but add value as optional just in case
    value: z.any().optional(),
});


// Union of all possible operations, including the internal one
export const JsonPatchOperationSchema = z.union([
  AddOperationSchema,
  RemoveOperationSchema,
  ReplaceOperationSchema,
  MoveOperationSchema,
  CopyOperationSchema,
  TestOperationSchema,
  GetOperationSchema, // Added internal operation
]);

// Type alias for convenience (matches fast-json-patch Operation)
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;

// Schema for an array of operations (common usage)
export const JsonPatchSchema = z.array(JsonPatchOperationSchema);

console.log("packages/server/src/utils/json-patch.ts loaded");