/**
 * Test-only stub for the `server-only` and `client-only` Next.js shim modules.
 *
 * Next.js replaces these bare specifiers at build time to enforce server/client
 * boundaries; Vitest does not perform that transform, so importing them under
 * the test runner fails to resolve. Vitest aliases both specifiers to this
 * empty module in `vitest.config.ts` so server-only utilities can be exercised
 * in jsdom. This file is never part of the production bundle.
 */
export {};
