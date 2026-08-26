# Frontend Standard

- Preserve `apps/web/src` paths named by `Notted.md`; use feature grouping within those boundaries when helpful.
- Use Server Components by default and client components only for required interaction/browser APIs.
- Keep API access in typed clients/hooks; presentation components do not know infrastructure details.
- Reuse shared Zod contracts, query keys, Shadcn primitives, and design tokens.
- Provide responsive loading, empty, error, retry, permission, optimistic rollback, and offline states.
- Meet keyboard, focus, semantics, screen-reader, contrast, zoom, and reduced-motion requirements.
- Use TanStack Query for server state and Zustand only for justified shared client state.
- Test user behavior and accessibility rather than implementation details.

## Browser support

- Support current Chrome, Edge, Firefox, and Safari/WebKit. Chromium is the maintained Playwright default and the only project an unqualified `pnpm e2e:test` runs.
- Cover the engine-divergent surfaces — contenteditable, clipboard, print, WebAuthn — in `apps/web/e2e/cross-browser.spec.ts`, run explicitly under `--project=firefox` and `--project=webkit` with that spec path. See [`testing.md`](testing.md) → Cross-browser runs.
- Edge is covered transitively by chromium; it is Chromium-equivalent for everything this application uses and has no project of its own.
