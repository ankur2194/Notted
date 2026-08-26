import { beforeEach, describe, expect, it } from "vitest";

import {
  httpRouteLabel,
  metricLabel,
  resetRouteLabelCacheForTests,
  statusClassLabel,
} from "./metrics.registry";

// `path` is deliberately `unknown`: `httpRouteLabel` runs inside the exception
// filter against whatever the HTTP adapter handed it, so the malformed-input
// cases below are the point of the helper, not an abuse of it.
const requestFor = (
  path: unknown,
  route?: { readonly path: string },
): Parameters<typeof httpRouteLabel>[0] =>
  ({ path, route }) as Parameters<typeof httpRouteLabel>[0];

/** A request as Express actually presents it: `originalUrl` never rewritten. */
const requestForUrl = (
  originalUrl: string,
  path: string,
  route?: { readonly path: string },
): Parameters<typeof httpRouteLabel>[0] =>
  ({ originalUrl, path, route }) as Parameters<typeof httpRouteLabel>[0];

describe("metricLabel", () => {
  it("keeps conservative values and rejects everything else", () => {
    expect(metricLabel("notted-export")).toBe("notted-export");
    expect(metricLabel("gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(metricLabel("claude.sonnet:v2")).toBe("claude.sonnet:v2");
    expect(metricLabel("")).toBe("other");
    expect(metricLabel(undefined)).toBe("other");
    expect(metricLabel(null)).toBe("other");
    // An admin authors `ai_usage.model` freely; a space, a quote or a newline in
    // a label value would corrupt the exposition format itself.
    expect(metricLabel("model name")).toBe("other");
    expect(metricLabel('a"b')).toBe("other");
    expect(metricLabel("a\nb")).toBe("other");
    expect(metricLabel("a".repeat(65))).toBe("other");
    expect(metricLabel("a".repeat(64))).toBe("a".repeat(64));
    expect(metricLabel("abcd", 3)).toBe("other");
  });
});

describe("statusClassLabel", () => {
  it("collapses statuses to their class", () => {
    expect(statusClassLabel(204)).toBe("2xx");
    expect(statusClassLabel(404)).toBe("4xx");
    expect(statusClassLabel(503)).toBe("5xx");
    expect(statusClassLabel(0)).toBe("other");
    expect(statusClassLabel(999)).toBe("other");
  });
});

describe("httpRouteLabel", () => {
  beforeEach(() => {
    resetRouteLabelCacheForTests();
  });

  it("buckets the three prefix surfaces", () => {
    expect(httpRouteLabel(requestFor("/api/v1/trpc/note.list"))).toBe("trpc");
    expect(httpRouteLabel(requestFor("/api/v1/trpc"))).toBe("trpc");
    expect(httpRouteLabel(requestFor("/api/auth/sign-in/email"))).toBe("auth");
    expect(httpRouteLabel(requestFor("/admin/queues/api/queues"))).toBe("bull-board");
    // A sibling path that merely starts with the same characters is NOT the bucket.
    expect(httpRouteLabel(requestFor("/api/v1/trpcfake"))).not.toBe("trpc");
  });

  it("buckets a mounted sub-handler from originalUrl, not the rewritten path", () => {
    // THE REGRESSION THIS EXISTS FOR. `app.use("/api/v1/trpc", handler)` and
    // `app.use("/api/auth", handler)` make Express strip the mount prefix from
    // `req.url`, and it is only restored in the `next()` callback a terminating
    // sub-handler never calls. Reading `req.path` in the `finish` listener
    // therefore saw `/notes.list` and `/sign-up/email` — one new time series per
    // tRPC procedure and per Better Auth sub-path, which is precisely the
    // unbounded cardinality the prefix buckets exist to prevent.
    expect(httpRouteLabel(requestForUrl("/api/v1/trpc/notes.list?batch=1", "/notes.list"))).toBe(
      "trpc",
    );
    expect(httpRouteLabel(requestForUrl("/api/auth/sign-up/email", "/sign-up/email"))).toBe("auth");
    expect(httpRouteLabel(requestForUrl("/admin/queues/api/queues", "/api/queues"))).toBe(
      "bull-board",
    );
  });

  it("normalizes the Express route template of a matched request", () => {
    expect(
      httpRouteLabel(
        requestFor("/api/v1/workspaces/0b7d0a3e-9f6d-4b3a-8c21-5f1e2d3c4b5a", {
          path: "/workspaces/:workspaceId",
        }),
      ),
    ).toBe("/workspaces/:id");
  });

  it("reuses a registered label for identifier-shaped paths that reached no handler", () => {
    // A request terminated by middleware (rate limit, CSRF, trusted host) has no
    // `request.route`, so its label comes from the sanitised URL. It must land
    // on the SAME series as the handler it was heading for.
    expect(
      httpRouteLabel(
        requestFor("/api/v1/notes/0b7d0a3e-9f6d-4b3a-8c21-5f1e2d3c4b5a", {
          path: "/api/v1/notes/:id",
        }),
      ),
    ).toBe("/api/v1/notes/:id");
    expect(httpRouteLabel(requestFor("/api/v1/notes/0b7d0a3e-9f6d-4b3a-8c21-5f1e2d3c4b5a"))).toBe(
      "/api/v1/notes/:id",
    );
    expect(httpRouteLabel(requestFor("/api/v1/notes/1234567890abcdef"))).toBe("/api/v1/notes/:id");
    expect(httpRouteLabel(requestFor("/api/v1/notes/42"))).toBe("/api/v1/notes/:id");
  });

  it("never throws on a request object that has no path", () => {
    // The exception filter is handed whatever the adapter gives it; a labeller
    // that throws there would turn a handled error into an unhandled crash.
    expect(httpRouteLabel(requestFor(undefined))).toBe("other");
    expect(httpRouteLabel(requestFor(""))).toBe("other");
    expect(httpRouteLabel(requestFor(42))).toBe("other");
    expect(httpRouteLabel(requestForUrl(42 as unknown as string, "/api/v1/notes"))).toBe("other");
  });

  it("refuses unsafe and over-deep route templates", () => {
    expect(httpRouteLabel(requestFor("/x", { path: "/api/v1/notes/a b" }))).toBe(
      "/api/v1/notes/other",
    );
    expect(httpRouteLabel(requestFor("/x", { path: "/a/b/c/d/e/f/g/h/i" }))).toBe("other");
  });

  it("caps the number of distinct route labels", () => {
    // Even matched routes are bounded: a hostile mount or a generated router
    // must not be able to grow the series count without limit.
    for (let index = 0; index < 200; index += 1) {
      expect(
        httpRouteLabel(requestFor(`/probe/path${index}`, { path: `/probe/path${index}` })),
      ).toBe(`/probe/path${index}`);
    }
    expect(httpRouteLabel(requestFor("/probe/path200", { path: "/probe/path200" }))).toBe("other");
    // Routes already seen keep working after the cap is reached.
    expect(httpRouteLabel(requestFor("/probe/path7", { path: "/probe/path7" }))).toBe(
      "/probe/path7",
    );
  });

  it("does not let unmatched paths spend slots in the cap", () => {
    // A 404 scan used to mint a label per probed path and permanently push every
    // route registered afterwards into `other`. An unmatched path is now `other`
    // straight away and never occupies a slot.
    for (let index = 0; index < 500; index += 1) {
      expect(httpRouteLabel(requestFor(`/api/v1/scan${index}`))).toBe("other");
    }
    expect(httpRouteLabel(requestFor("/api/v1/notes", { path: "/api/v1/notes" }))).toBe(
      "/api/v1/notes",
    );
  });
});
