# Project Conventions

## Code Style & Formatting
- **ESLint:** Use `@sylphlab/eslint-config-sylph-strict-react` (or appropriate variant). Enforces strict typing, FP hints, naming conventions.
- **Prettier:** Use `@sylphlab/prettier-config`.
- **File Naming:** PascalCase for components (`MyComponent.tsx`), kebab-case for others (`my-utility.ts`).

## Testing
- **Framework:** Vitest.
- **Mocks:** `vi.mock`, `vi.fn()`. Use `vitest-websocket-mock` for WebSocket testing.
- **Co-location:** Test files (`*.test.ts(x)`, `*.spec.ts(x)`) **MUST** reside in the same directory as the source file.
- **Coverage:** Aim for > 80% lines and branches for core packages. Critical logic requires near 100%.
- **Timeouts:** Keep tests fast. Individual tests ideally < 500ms. Integration tests < 2000ms (2s). **Strict enforcement.**

## Commits & Versioning
- **Conventional Commits:** Mandatory. Use `commitlint` with `@commitlint/config-conventional`.
- **Changesets:** Use `@changesets/cli` for versioning and changelogs. Publishing via CI only.

## Project Structure
- **Monorepo:** pnpm workspaces + Turborepo.
- **Package Building:** Use `tsup`. Configure `dts: true` and `external` for workspace packages. No `composite: true` or `references` in `tsconfig.json` for `tsup`-built packages.

## Dependencies
- Prioritize native APIs, then tiny, modern libraries. Evaluate bundle size/performance impact.

## TypeScript
- Strict mode enabled.
- Favor Functional Programming patterns where practical.
- Use `zod` for runtime validation where necessary.