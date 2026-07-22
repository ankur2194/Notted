# Frontend Standard

- Preserve `apps/web/src` paths named by `Notted.md`; use feature grouping within those boundaries when helpful.
- Use Server Components by default and client components only for required interaction/browser APIs.
- Keep API access in typed clients/hooks; presentation components do not know infrastructure details.
- Reuse shared Zod contracts, query keys, Shadcn primitives, and design tokens.
- Provide responsive loading, empty, error, retry, permission, optimistic rollback, and offline states.
- Meet keyboard, focus, semantics, screen-reader, contrast, zoom, and reduced-motion requirements.
- Use TanStack Query for server state and Zustand only for justified shared client state.
- Test user behavior and accessibility rather than implementation details.
