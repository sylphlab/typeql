import type { Task } from 'nanostores';
import type { OptimisticSyncCoordinator } from '../coordinator'; // Assuming coordinator types exist
import type { ZenQueryClient } from '../client'; // Assuming client type exists

// --- Placeholder Nanostore/Patch Types ---

/** Placeholder for a Nanostore Atom */
export interface PlaceholderAtom<T = any> {
  get(): T;
  set(value: T): void;
  // subscribe(listener: (value: T) => void): () => void;
  // listen(listener: (value: T) => void): () => void;
  // task?: Task; // For effect/mutation integration if needed later
}

/** JSON Patch object (RFC 6902) */
export type Patch = {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: any;
  from?: string; // Only used by 'move' and 'copy'
};

/** Placeholder for Atom Key */
export type AtomKey = string | symbol;

/** Placeholder for produceWithPatches result */
export type ProduceResult<T> = {
  newState: T;
  patches: Patch[];
  inversePatches: Patch[];
};

/** Placeholder for produceWithPatches function */
export type ProduceWithPatches = <T>(
  currentState: T,
  recipe: (draft: T) => T | void
) => ProduceResult<T>;

/** Placeholder for applyPatches function */
export type ApplyPatches = <T>(currentState: T, patches: Patch[]) => T;

// --- Helper Specific Types ---

export type ClientSelector<TClient extends ZenQueryClient = ZenQueryClient> = (
  get: <A>(atom: PlaceholderAtom<A>) => A
) => TClient;

export type CoordinatorSelector = (
  client: ZenQueryClient
) => OptimisticSyncCoordinator;

// --- Query Helper Types ---

export interface QueryOptions<TInput = any, TData = any> {
  key: AtomKey; // Unique key for registration and pending patch mapping
  input?: TInput;
  initialData?: TData;
  enabled?: boolean; // Placeholder for enabling/disabling
  // TODO: Add other options like staleTime, gcTime etc.
}

export interface QueryAtomValue<TData = any, TError = Error> {
  data: TData | undefined;
  loading: boolean;
  error: TError | null;
  reload: () => void; // Function to manually trigger a refetch
}

export type QueryAtom<TData = any, TError = Error> = PlaceholderAtom<
  QueryAtomValue<TData, TError>
>;

// --- Subscription Helper Types ---

export interface SubscriptionOptions<TInput = any> {
  key: AtomKey; // Unique key for registration and pending patch mapping
  input?: TInput;
  enabled?: boolean; // Placeholder for enabling/disabling
  // TODO: Add other options
}

export type SubscriptionStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface SubscriptionAtomValue<TData = any, TError = Error> {
  data: TData | undefined;
  status: SubscriptionStatus;
  error: TError | null;
}

export type SubscriptionAtom<TData = any, TError = Error> = PlaceholderAtom<
  SubscriptionAtomValue<TData, TError>
>;

// --- Mutation Helper Types ---

/** Recipe function for optimistic updates */
export type ApplyPatchRecipe<TState = any, TInput = any> = (
  currentState: TState,
  input: TInput
) => TState | void; // Immer-style recipe

/** Effect definition */
export interface MutationEffect<TState = any, TInput = any> {
  targetAtom: PlaceholderAtom<TState>;
  applyPatchRecipe: ApplyPatchRecipe<TState, TInput>;
  // key: AtomKey; // Key derived from targetAtom
}

export interface MutationOptions<TInput = any, TOutput = any, TError = Error> {
  // TODO: Add onSuccess, onError, onSettled callbacks - Added signatures
  onSuccess?: (data: TOutput, input: TInput) => void;
  onError?: (error: TError, input: TInput) => void;
  onSettled?: (data: TOutput | undefined, error: TError | null, input: TInput) => void;
}

export interface MutationAtomValue<TInput = any, TOutput = any, TError = Error> {
  mutate: (input: TInput) => Promise<TOutput | undefined>; // Or void? Needs clarification
  loading: boolean;
  error: TError | null;
  // data?: TOutput; // Last successful mutation result?
}

export type MutationAtom<
  TInput = any,
  TOutput = any,
  TError = Error,
> = PlaceholderAtom<MutationAtomValue<TInput, TOutput, TError>>;

// --- Utility Types ---

/** Placeholder for the Atom Registry */
export interface AtomRegistry {
  registerQueryAtom(key: AtomKey, atom: QueryAtom): void;
  registerSubscriptionAtom(key: AtomKey, atom: SubscriptionAtom): void;
  getQueryAtom(key: AtomKey): QueryAtom | undefined;
  getSubscriptionAtom(key: AtomKey): SubscriptionAtom | undefined;
  // Unregister methods added
  unregisterQueryAtom(key: AtomKey): boolean;
  unregisterSubscriptionAtom(key: AtomKey): boolean;
}