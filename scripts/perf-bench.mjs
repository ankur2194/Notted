#!/usr/bin/env node

/**
 * Part 77 — the performance and scale harness.
 *
 * WHY A PLAIN SCRIPT AND NOT A LOAD-TESTING TOOL. autocannon, k6 and artillery
 * all measure a URL. Every interesting Notted endpoint is behind a verified
 * account, a workspace membership, a trusted `Origin`, and — on the expensive
 * POSTs — a mandatory `Idempotency-Key`. Teaching a load generator that
 * handshake costs more than the handshake, and the numbers it would then report
 * are for a session it holds open forever, which is not how the product is
 * used. Global `fetch` plus `performance.now()` is the whole dependency list.
 *
 * WHY IT GENERATES THROUGH THE REAL API. Raw SQL would be an order of magnitude
 * faster and would produce a database that does not resemble production: no
 * Meilisearch documents, so `api.search` would measure an empty index; no
 * version snapshots and no idempotency rows, so the write path would be
 * measured without the rows it actually writes. Generating through the API also
 * makes generation itself the `api.notes.create` sample set, for free.
 *
 * WHY IT IS NOT A NEST CLI. `apps/api/scripts/storage-report.ts` boots a Nest
 * context because it inspects internal state. This one must not: an in-process
 * caller skips the guards, the rate limiters, and the HTTP layer that are
 * exactly what the budgets are about. It is an external client and nothing else.
 *
 * WHY IT WRITES NO RESULTS FILE. A checked-in results file rots the moment the
 * hardware or the fixture changes, and then reads as a fact. The table goes into
 * the completion record next to the host it was taken on, or nowhere.
 *
 * Usage (against the `e2e` profile — see docs/standards/performance.md):
 *   node scripts/perf-bench.mjs seed --notes=1000 --tasks=2000
 *   node scripts/perf-bench.mjs run
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Hard ceilings, in the file rather than in a flag's default, so no invocation
 * can ask this host for a fixture it cannot hold. `--notes`/`--tasks` clamp.
 */
export const MAX_NOTES = 2000;
export const MAX_TASKS = 5000;

/**
 * Four in flight. Not tuned for throughput — tuned to stay far below the
 * authenticated rate-limit tier while still being concurrent enough that the
 * numbers include lock and pool contention rather than describing a server
 * talking to exactly one client.
 *
 * INERT AGAINST THE DEFAULT TARGET. The `e2e` profile raises
 * `RATE_LIMIT_AUTHENTICATED_PER_MINUTE` to 1000000 (compose.yaml), so no
 * realistic setting of this constant could trip the limiter there and the
 * 429-VOID path below is unreachable on that stack. Both are kept anyway:
 * `PERF_API_URL` can point this harness at any environment, and against one
 * with production limits a run that silently averaged in refused requests would
 * report a slow server that was in fact a throttled client.
 */
const CONCURRENCY = 4;

/**
 * Nearest-rank p95 over fewer than twenty samples is a ranking of noise: at
 * n=10 the "95th percentile" is simply the maximum. A scenario that cannot
 * produce twenty samples is reported VOID rather than given a number.
 */
export const MIN_SAMPLES = 20;

/**
 * Handover between `seed` and `run` lives outside the repository on purpose —
 * a state file inside `scripts/` would eventually be committed and would then
 * point a later run at a workspace that no longer exists.
 */
const STATE_FILE = join(tmpdir(), "notted-perf-bench.json");

/** Meets the password policy; nothing here varies it. */
const PASSWORD = "Fresh1!Password";

/**
 * The token every generated note carries in its title, so `api.search` matches
 * the whole corpus. Deliberately not a real word: a dictionary word could also
 * match note *body* text and make the result count depend on the filler prose.
 */
const SEARCH_TOKEN = "zylophant";

/**
 * The large-document fixture, sized against ALL of `NOTE_DOCUMENT_LIMITS`
 * (packages/shared-validators/src/document.schema.ts), not just one of them.
 *
 * It was 380 x 500, chosen against `maxTotalText` (200000) alone — and rejected
 * by `maxChildren` (200), which caps the number of direct children of the `doc`
 * node. Every `seed` run therefore died on `POST /notes` with a bare
 * `VALIDATION_ERROR` before a single measurement was taken. 190 paragraphs of
 * 1000 characters is the same amount of prose under both ceilings: ~191 KB of
 * text, ~202 KB serialized against a 512000-byte cap, and 190 children.
 * `scripts/perf-bench.test.mjs` asserts all three so this cannot rot again.
 */
const LARGE_DOCUMENT_PARAGRAPHS = 190;
const LARGE_DOCUMENT_PARAGRAPH_CHARS = 1000;

/** The volume `bulk.upload` would have used, recorded so the omission is legible. */
export const SKIPPED_BULK_UPLOAD = Object.freeze({
  files: 50,
  bytesEach: 2 * 1024 * 1024,
  reason:
    "MinIO multipart traffic plus a Puppeteer-capable API container competing for this host's free memory is not a combination to ask for. Measure on VPS-class hardware.",
});

// ---------------------------------------------------------------------------
// Pure helpers. Everything below the CLI guard imports these; scripts/perf-bench.test.mjs
// asserts on them without touching the network.
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile: `sorted[ceil(fraction * n) - 1]`.
 *
 * NEVER interpolated. An interpolated p95 is a number the server was never
 * observed to produce, and a budget is a claim about observed behavior. At n=1
 * this returns the only sample; at n=2 it returns the larger one.
 */
export function percentile(samples, fraction) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  // `max(..., 1)` keeps `fraction: 0` (the min cell in the table) on rank 1
  // instead of index -1; every other fraction is untouched nearest-rank.
  return sorted[Math.max(Math.ceil(fraction * sorted.length), 1) - 1];
}

/**
 * PASS / FAIL / VOID / NOT MEASURED / SKIPPED for one scenario.
 *
 * VOID outranks FAIL on purpose: a run that saw an error or a 429 did not
 * measure a slow server, it measured a broken run, and reporting that as a
 * missed budget would send someone optimizing a path that was never sampled.
 */
export function evaluateStatus(result, spec) {
  if (result.skipped !== undefined) return "SKIPPED";
  if (result.errors > 0 || result.rateLimited > 0) return "VOID";
  // A scenario that fell back to measuring something else is never scored
  // against this budget, however good its numbers look. Scoring it would let a
  // fast heartbeat certify a propagation budget nobody measured.
  if (result.measuredSomethingElse === true) return "NOT MEASURED";
  const budget = spec?.p95Ms ?? null;
  if (result.samples.length === 0) return budget === null ? "NOT MEASURED" : "VOID";
  if (result.samples.length < MIN_SAMPLES) return "VOID";
  if (budget === null) return "NOT MEASURED";
  return percentile(result.samples, 0.95) <= budget ? "PASS" : "FAIL";
}

function milliseconds(value) {
  return value === null || value === undefined ? "—" : `${Math.round(value)}`;
}

/** The budget cell: milliseconds, or the one build-time budget's kilobytes. */
export function formatBudget(spec) {
  if (spec === undefined) return "none";
  if (spec.p95Ms !== null && spec.p95Ms !== undefined) return `${spec.p95Ms} ms`;
  if (spec.kilobytes !== undefined) return `${spec.kilobytes} kB`;
  return "none";
}

export const TABLE_COLUMNS = Object.freeze([
  "Scenario",
  "n",
  "min",
  "p50",
  "p95",
  "max",
  "errors",
  "429s",
  "budget",
  "status",
  "notes",
]);

export const TABLE_HEADER = `| ${TABLE_COLUMNS.join(" | ")} |\n| ${TABLE_COLUMNS.map(() => "---").join(" | ")} |`;

/**
 * One markdown row. A scenario with no samples prints em dashes rather than
 * `NaN` — `NaN ms` in a results table reads as a measurement, and it is not one.
 */
export function formatRow(id, result, spec) {
  const status = evaluateStatus(result, spec);
  const cells = [
    `\`${id}\``,
    String(result.samples.length),
    milliseconds(percentile(result.samples, 0)),
    milliseconds(percentile(result.samples, 0.5)),
    milliseconds(percentile(result.samples, 0.95)),
    milliseconds(percentile(result.samples, 1)),
    String(result.errors),
    String(result.rateLimited),
    formatBudget(spec),
    status,
    result.skipped ?? result.note ?? "",
  ];
  return `| ${cells.join(" | ")} |`;
}

export function renderTable(results, budgets) {
  const rows = Object.entries(results).map(([id, result]) =>
    formatRow(id, result, budgets.scenarios[id]),
  );
  return [TABLE_HEADER, ...rows].join("\n");
}

/** A scenario result with every counter present, so no caller has to defend against undefined. */
export function emptyResult(extra = {}) {
  return { samples: [], errors: 0, rateLimited: 0, ...extra };
}

function clamp(raw, fallback, ceiling, flag) {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return Math.min(value, ceiling);
}

/**
 * `--notes`/`--tasks` are clamped, not rejected, when they exceed the ceiling:
 * an operator who asks for more than this host can hold gets the largest
 * fixture that fits, and the run still happens.
 */
export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== "seed" && command !== "run") {
    throw new Error(`Unknown command "${command ?? ""}". Expected "seed" or "run".`);
  }
  const flags = new Map(
    rest.map((argument) => {
      const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
      if (match === null) throw new Error(`Unrecognized argument "${argument}"`);
      return [match[1], match[2]];
    }),
  );
  if (command === "run") {
    // `run` reads the fixture size from the state file `seed` wrote. Silently
    // accepting `--notes=2000` here would let an operator believe they had
    // resized a corpus that in fact never changed.
    const stray = ["notes", "tasks"].filter((name) => flags.has(name));
    if (stray.length > 0) {
      throw new Error(
        `${stray.map((name) => `--${name}`).join(", ")} only applies to "seed"; ` +
          `"run" measures whatever "seed" built. Re-seed to change the fixture size.`,
      );
    }
  }
  return {
    command,
    notes: clamp(flags.get("notes"), 1000, MAX_NOTES, "--notes"),
    tasks: clamp(flags.get("tasks"), 2000, MAX_TASKS, "--tasks"),
  };
}

/**
 * The hard ceiling on how deep the SEARCH API can be paged, which is what makes
 * a settle predicate possible at all.
 *
 * `MAX_CANDIDATES` in `apps/api/src/search/search.service.ts` is 200: the
 * service scans provider windows from offset zero, authorizes them, and slices
 * the requested page out of the authorized list — and it stops after 200
 * candidates. So no query can ever surface an authorized result past index 200,
 * whatever the corpus size, and page 3 of 100 is structurally empty forever.
 */
export const SEARCH_AUTHORIZED_CEILING = 200;

/**
 * H4 — what a SETTLED search corpus must report, and on which page.
 *
 * `SearchPage.total` is the number of authorized items on THIS page, not the
 * size of the corpus (`packages/shared-types/src/search.ts`). Polling
 * `limit=1` until `total` stopped moving therefore settled at `1` within about
 * three seconds — before Meilisearch had indexed anything — and the search
 * scenario went on to sample a half-built index while the seed printed
 * "1 notes indexed".
 *
 * The replacement asks a question only a filled index can answer: the deepest
 * page that must be FULL, plus whether anything is meant to lie beyond it.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. Because of the ceiling above, the strongest
 * available claim is "at least `SEARCH_AUTHORIZED_CEILING` documents are
 * searchable" — the search API is structurally incapable of reporting more, so
 * a predicate over the whole 1001-document corpus is not something an external
 * client can express. That is the right bound anyway: the `api.search` scenario
 * pages from offset zero and its cost is bounded by the same constant.
 */
export function corpusProbe(documents, limit = 100, ceiling = SEARCH_AUTHORIZED_CEILING) {
  const reachable = Math.min(documents, ceiling);
  const page = Math.max(Math.floor(reachable / limit), 1);
  return {
    page,
    limit,
    total: Math.min(limit, Math.max(reachable - (page - 1) * limit, 0)),
    hasMore: reachable > page * limit,
  };
}

/** True when one poll's page matches what a settled corpus must report. */
export function corpusPageSettled(probe, body) {
  return body?.total === probe.total && body?.hasMore === probe.hasMore;
}

// ---------------------------------------------------------------------------
// HTTP client. Fail-fast by construction.
// ---------------------------------------------------------------------------

class BenchHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "BenchHttpError";
    this.status = status;
  }
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export function environment() {
  return {
    // Defaults are the `e2e` profile's published ports. The development stack
    // is deliberately NOT the default: benchmarking it would write thousands of
    // rows into the database a developer is using.
    appUrl: process.env.PERF_APP_URL ?? "http://localhost:3010",
    apiUrl: process.env.PERF_API_URL ?? "http://localhost:3011",
    // `PERF_MAILPIT_URL`, NOT `PLAYWRIGHT_MAILPIT_URL`: the latter is documented
    // repo-wide as the CONTAINER-internal `http://mailpit:8025`
    // (scripts/dev-tooling.mjs), which this out-of-container script cannot
    // reach. Falling back through `NOTTED_MAILPIT_WEB_PORT` — the one existing
    // name that means "published host port", read by `compose.yaml` — makes the
    // default correct on a checkout that shifted its ports, instead of sending
    // the reviewer to a port nothing is listening on.
    mailpitUrl:
      process.env.PERF_MAILPIT_URL ??
      `http://localhost:${process.env.NOTTED_MAILPIT_WEB_PORT ?? "8025"}`,
    cookie: null,
  };
}

/**
 * Every request. Returns the elapsed wall time alongside the response, because
 * timing at the call site would also time the JSON parse of the caller's choice.
 *
 * A non-2xx throws — including 429. A run that trips a rate limit has not
 * measured a slow server; it has produced samples taken while the server was
 * refusing work, and averaging those in would understate every budget.
 */
async function call(ctx, method, path, options = {}) {
  const headers = { Origin: ctx.appUrl, Accept: "application/json" };
  if (ctx.cookie !== null) headers.Cookie = ctx.cookie;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    // Cheap and always correct: the endpoints that require a key reject a
    // request without one, and the ones that ignore it are unharmed.
    headers["Idempotency-Key"] = randomUUID();
  }
  const url = path.startsWith("http") ? path : `${ctx.apiUrl}${path}`;
  const started = performance.now();
  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: options.redirect ?? "follow",
  });
  const elapsed = performance.now() - started;
  const accepted = options.allowStatus ?? [];
  if (!response.ok && !accepted.includes(response.status)) {
    const detail = await response.text().catch(() => "");
    throw new BenchHttpError(
      `${method} ${path} -> ${response.status}${
        response.status === 429 ? " (rate limited: this run is VOID, not slow)" : ""
      } ${detail.slice(0, 200)}`,
      response.status,
    );
  }
  return { response, elapsed };
}

async function json(ctx, method, path, options) {
  const { response, elapsed } = await call(ctx, method, path, options);
  return { body: await response.json(), elapsed };
}

/** Bounded fan-out. Results keep input order so a caller can pair them with ids. */
async function inParallel(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Tenant provisioning.
// ---------------------------------------------------------------------------

/**
 * Mirrors `apps/web/e2e/mailpit.ts` in plain `fetch`. That module cannot be
 * imported here: it takes a Playwright `APIRequestContext` and pulls in
 * `@playwright/test`, which would make this harness depend on the browser suite.
 */
async function actionLink(ctx, recipient, subjectIncludes) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const list = await fetch(`${ctx.mailpitUrl}/api/v1/messages`).catch(() => null);
    if (list !== null && list.ok) {
      const payload = await list.json();
      const match = (payload.messages ?? []).find(
        (message) =>
          (message.To ?? []).some(
            (to) => (to.Address ?? "").toLowerCase() === recipient.toLowerCase(),
          ) && (message.Subject ?? "").includes(subjectIncludes),
      );
      if (match !== undefined) {
        const detail = await fetch(`${ctx.mailpitUrl}/api/v1/message/${match.ID}`);
        const body = await detail.json();
        const content = `${body.Text ?? ""}\n${body.HTML ?? ""}`.replaceAll("&amp;", "&");
        const url = /https?:\/\/[^\s"'<>]+/u.exec(content);
        if (url !== null) return url[0];
      }
    }
    await delay(500);
  }
  throw new Error(
    `No "${subjectIncludes}" mail for ${recipient} at ${ctx.mailpitUrl}. Is the stack up and PERF_MAILPIT_URL correct?`,
  );
}

/**
 * Register, verify, sign in, and keep the session cookie.
 *
 * A SESSION, never an API key. The API-key rate-limit tier is 100/min; the
 * authenticated session tier is 1000/min. Generating a thousand notes through
 * the key tier would trip the limiter and void its own run.
 */
async function provisionTenant(ctx) {
  const email = `perf.${randomUUID()}@example.test`;
  await call(ctx, "POST", "/api/auth/sign-up/email", {
    body: {
      name: "Notted Perf",
      email,
      password: PASSWORD,
      callbackURL: "/verify-email?status=success",
    },
  });

  const link = await actionLink(ctx, email, "Verify your Notted email");
  // The handler answers 302 to the web app; following it would need `web-e2e`
  // warm and proves nothing about verification.
  await call(ctx, "GET", link, { redirect: "manual", allowStatus: [302] });

  const signIn = await call(ctx, "POST", "/api/auth/sign-in/email", {
    body: { email, password: PASSWORD, rememberMe: false },
  });
  const cookie = signIn.response.headers
    .getSetCookie()
    .map((entry) => entry.split(";", 1)[0])
    .join("; ");
  if (cookie.length === 0) throw new Error("Sign-in returned no session cookie");
  ctx.cookie = cookie;

  const { body } = await json(ctx, "POST", "/api/v1/workspaces", {
    body: {
      name: "Perf workspace",
      slug: `perf-${randomUUID().slice(0, 12)}`,
      description: null,
    },
  });
  return { email, cookie, workspaceId: body.workspace.id };
}

// ---------------------------------------------------------------------------
// Fixture generation.
// ---------------------------------------------------------------------------

export function largeDocument() {
  const filler =
    "Scale fixture prose for the large-document read scenario, long enough that the paragraph is realistic. ";
  const paragraph = filler
    .repeat(Math.ceil(LARGE_DOCUMENT_PARAGRAPH_CHARS / filler.length))
    .slice(0, LARGE_DOCUMENT_PARAGRAPH_CHARS);
  return {
    type: "doc",
    content: Array.from({ length: LARGE_DOCUMENT_PARAGRAPHS }, (_, index) => ({
      type: "paragraph",
      content: [{ type: "text", text: `${index + 1}. ${paragraph}` }],
    })),
  };
}

async function createNote(ctx, workspaceId, body) {
  return json(ctx, "POST", `/api/v1/workspaces/${workspaceId}/notes`, { body });
}

/**
 * A deep tree and a wide one at the same time.
 *
 * The first eight notes are created sequentially because each is the parent of
 * the next — that is the depth-8 spine, and it cannot be parallelized. Every
 * remaining note hangs off one of those eight, which keeps the fan-out
 * concurrent while guaranteeing the tree is genuinely deep rather than a flat
 * list with one long branch bolted on.
 */
async function generateNotes(ctx, workspaceId, total) {
  const samples = [];
  const spine = [];
  let parentId = null;
  for (let depth = 0; depth < Math.min(8, total); depth += 1) {
    const created = await createNote(ctx, workspaceId, {
      title: `Perf ${SEARCH_TOKEN} spine depth ${depth + 1}`,
      parentId,
    });
    samples.push(created.elapsed);
    parentId = created.body.note.id;
    spine.push(parentId);
  }

  const remaining = Array.from({ length: Math.max(total - spine.length, 0) }, (_, index) => index);
  const children = await inParallel(remaining, CONCURRENCY, async (index) => {
    const created = await createNote(ctx, workspaceId, {
      title: `Perf ${SEARCH_TOKEN} note ${String(index + 1).padStart(5, "0")}`,
      parentId: spine[index % spine.length],
    });
    samples.push(created.elapsed);
    return created.body.note.id;
  });

  const large = await createNote(ctx, workspaceId, {
    title: `Perf ${SEARCH_TOKEN} large document`,
    content: largeDocument(),
  });
  samples.push(large.elapsed);

  return { samples, spine, noteIds: [...spine, ...children], largeNoteId: large.body.note.id };
}

const TASK_STATUSES = ["todo", "in_progress", "done", "canceled"];
const TASK_PRIORITIES = ["low", "medium", "high", "urgent"];

async function generateTasks(ctx, workspaceId, total, noteIds) {
  const indexes = Array.from({ length: total }, (_, index) => index);
  await inParallel(indexes, CONCURRENCY, async (index) =>
    call(ctx, "POST", `/api/v1/workspaces/${workspaceId}/tasks`, {
      body: {
        title: `Perf task ${String(index + 1).padStart(5, "0")}`,
        status: TASK_STATUSES[index % TASK_STATUSES.length],
        priority: TASK_PRIORITIES[index % TASK_PRIORITIES.length],
        // Every fourth task hangs off a note, so the list query exercises the
        // note join rather than only the bare workspace scan.
        noteId: index % 4 === 0 ? noteIds[index % noteIds.length] : null,
      },
    }),
  );
}

/**
 * Meilisearch indexing happens after commit, so the corpus is still growing
 * when generation returns. Sampling then would measure an index of unknown
 * size.
 *
 * The predicate is `corpusProbe` above — the deepest page that must be full,
 * and whether a result must exist beyond it — held across two consecutive
 * polls. A single match is not enough: Meilisearch fills the index in batches,
 * and a page can be momentarily complete while later documents are still
 * arriving.
 */
async function waitForSearchCorpus(ctx, workspaceId, expected) {
  // `expected` notes plus the one large document; all of them carry SEARCH_TOKEN.
  const documents = expected + 1;
  const probe = corpusProbe(documents);
  const deadline = Date.now() + 180_000;
  let stable = 0;
  let last = null;
  while (Date.now() < deadline) {
    const { body } = await json(
      ctx,
      "GET",
      `/api/v1/workspaces/${workspaceId}/search?query=${SEARCH_TOKEN}` +
        `&limit=${probe.limit}&page=${probe.page}`,
    );
    last = body;
    stable = corpusPageSettled(probe, body) ? stable + 1 : 0;
    if (stable >= 2) return Math.min(documents, SEARCH_AUTHORIZED_CEILING);
    await delay(1000);
  }
  throw new Error(
    `Search corpus never settled: page ${probe.page} of ${probe.limit} reported total ` +
      `${last?.total} / hasMore ${last?.hasMore}, expected ${probe.total} / ${probe.hasMore} ` +
      `(${documents} documents seeded, ${SEARCH_AUTHORIZED_CEILING} reachable through the search ` +
      `API). Meilisearch may still be indexing or unavailable.`,
  );
}

async function seed(options) {
  const ctx = environment();
  process.stdout.write(`Provisioning a tenant against ${ctx.apiUrl}\n`);
  const tenant = await provisionTenant(ctx);

  process.stdout.write(`Generating ${options.notes} notes (spine 8 deep) + one large document\n`);
  const notes = await generateNotes(ctx, tenant.workspaceId, options.notes);

  process.stdout.write(
    `Generating ${options.tasks} tasks across ${TASK_STATUSES.length} statuses\n`,
  );
  await generateTasks(ctx, tenant.workspaceId, options.tasks, notes.noteIds);

  process.stdout.write("Waiting for the search corpus to settle\n");
  const indexed = await waitForSearchCorpus(ctx, tenant.workspaceId, options.notes);

  await writeFile(
    STATE_FILE,
    JSON.stringify(
      {
        seededAt: new Date().toISOString(),
        apiUrl: ctx.apiUrl,
        appUrl: ctx.appUrl,
        cookie: tenant.cookie,
        workspaceId: tenant.workspaceId,
        // A rotation set, not the whole fixture: `run` only needs enough ids to
        // avoid sampling the same row twenty times into a warm cache.
        noteIds: notes.noteIds.slice(0, 200),
        largeNoteId: notes.largeNoteId,
        createSamples: notes.samples,
        notes: options.notes,
        tasks: options.tasks,
        indexed,
      },
      null,
      2,
    ),
    "utf8",
  );
  process.stdout.write(
    `Seeded. ${indexed} documents searchable (API ceiling). State: ${STATE_FILE}\n`,
  );
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

/**
 * Samples one HTTP scenario. On the first non-2xx it stops sampling that
 * scenario, records the error, and returns — the run continues so the table
 * still shows where things stood, and `main` exits non-zero.
 */
async function sampleHttp(ctx, count, request) {
  const result = emptyResult();
  for (let index = 0; index < count; index += 1) {
    try {
      const { elapsed } = await request(index);
      result.samples.push(elapsed);
    } catch (error) {
      result.errors += 1;
      if (error instanceof BenchHttpError && error.status === 429) result.rateLimited += 1;
      result.note = String(error.message).slice(0, 120);
      return result;
    }
  }
  return result;
}

const SAMPLES = 30;

/**
 * Export wall time: four rounds of five single-note PDF jobs SUBMITTED at once.
 *
 * NOT "five concurrent renders". The export worker's concurrency is pinned to 2
 * (`REQUIRED_EXPORT_CONCURRENCY`, apps/api/src/queue/queue-infrastructure.service.ts),
 * so a batch of five is two rendering and three queued; what is measured is
 * therefore submit-to-ready wall time under a five-deep burst, which includes
 * queue wait by design — that is the number a user experiences. Four rounds is
 * what gets it to twenty samples, because a p95 over five numbers is just the
 * maximum. The 500 ms status poll below also quantises every sample to the
 * nearest half second, which is immaterial against a 30 s budget and would not
 * be against a sub-second one.
 */
async function sampleExports(ctx, state) {
  const result = emptyResult();
  for (let round = 0; round < 4; round += 1) {
    const batch = Array.from({ length: 5 }, (_, index) => state.noteIds[round * 5 + index]);
    try {
      const elapsed = await Promise.all(
        batch.map(async (noteId) => {
          const started = performance.now();
          const { body } = await json(
            ctx,
            "POST",
            `/api/v1/workspaces/${state.workspaceId}/exports`,
            {
              body: { format: "pdf", sourceType: "note", sourceId: noteId },
            },
          );
          const deadline = Date.now() + 120_000;
          while (Date.now() < deadline) {
            const status = await json(
              ctx,
              "GET",
              `/api/v1/workspaces/${state.workspaceId}/exports/${body.id}`,
            );
            if (status.body.status === "ready") return performance.now() - started;
            if (["failed", "cancelled", "expired"].includes(status.body.status)) {
              throw new Error(`export ${body.id} ended ${status.body.status}`);
            }
            await delay(500);
          }
          throw new Error(`export ${body.id} did not finish within 120 s`);
        }),
      );
      result.samples.push(...elapsed);
    } catch (error) {
      result.errors += 1;
      if (error instanceof BenchHttpError && error.status === 429) result.rateLimited += 1;
      result.note = String(error.message).slice(0, 120);
      return result;
    }
  }
  return result;
}

/**
 * `socket.io-client` and `yjs` are dependencies of `apps/web`, not of the root,
 * and pnpm does not hoist them — so they are resolved through `apps/web`'s own
 * resolution root rather than imported by bare specifier. Dynamic, inside a
 * try, so a workspace that has not been installed degrades to a SKIPPED row
 * instead of taking down the whole run.
 */
async function loadRealtimeDependencies() {
  const requireFromWeb = createRequire(join(here, "..", "apps", "web", "package.json"));
  const [socketModule, yjsModule] = await Promise.all([
    import(pathToFileURL(requireFromWeb.resolve("socket.io-client")).href),
    import(pathToFileURL(requireFromWeb.resolve("yjs")).href),
  ]);
  return { io: socketModule.io, Y: yjsModule };
}

function emitAck(socket, event, payload, timeoutMs) {
  return new Promise((settle, fail) => {
    socket.timeout(timeoutMs).emit(event, payload, (transportError, ack) => {
      if (transportError) fail(new Error(`${event} timed out after ${timeoutMs} ms`));
      else if (ack === undefined || ack.ok !== true)
        fail(new Error(`${event} refused: ${ack?.error ?? "unknown"}`));
      else settle(ack);
    });
  });
}

function connect(io, state, timeoutMs) {
  const socket = io(state.apiUrl, {
    path: "/socket.io",
    transports: ["websocket"],
    // Identity travels in the session cookie exactly as the browser client
    // sends it; there is no token parameter on this gateway.
    extraHeaders: { Cookie: state.cookie, Origin: state.appUrl },
    reconnection: false,
  });
  return new Promise((settle, fail) => {
    const timer = setTimeout(() => {
      socket.close();
      fail(new Error(`socket never became ready within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.on("realtime:ready", () => {
      clearTimeout(timer);
      settle(socket);
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      socket.close();
      fail(new Error(`socket connect_error: ${error.message}`));
    });
  });
}

const WS_SAMPLES = 20;
const WS_HANDSHAKE_ATTEMPTS = 3;
const WS_ACK_TIMEOUT_MS = 5_000;

/**
 * Four concurrent editors on one note; A writes, B timestamps the broadcast.
 *
 * TIME-BOXED BY DESIGN. The Yjs sync/epoch handshake is the most fragile thing
 * this harness touches, and a benchmark that hangs on its riskiest scenario has
 * measured nothing at all. After `WS_HANDSHAKE_ATTEMPTS` failures it falls back
 * to the heartbeat ack round-trip and SAYS SO in the row's note — a server
 * round-trip is a weaker claim than end-to-end propagation, and mislabelling it
 * as propagation would be the dishonest half of the shortcut, not the cheap one.
 */
async function sampleRealtime(state) {
  let io;
  let Y;
  try {
    ({ io, Y } = await loadRealtimeDependencies());
  } catch (error) {
    return emptyResult({
      skipped: `socket.io-client/yjs not resolvable from apps/web (${String(error.message).slice(0, 60)})`,
    });
  }

  const sockets = [];
  const result = emptyResult();
  try {
    for (let index = 0; index < 4; index += 1) {
      sockets.push(await connect(io, state, 10_000));
    }
    const selector = { kind: "note", workspaceId: state.workspaceId, noteId: state.noteIds[0] };
    for (const socket of sockets) {
      await emitAck(socket, "realtime:room:join", { selector }, WS_ACK_TIMEOUT_MS);
    }

    const doc = new Y.Doc();
    let epoch = 0;
    for (let attempt = 0; attempt < WS_HANDSHAKE_ATTEMPTS && epoch === 0; attempt += 1) {
      try {
        const ack = await emitAck(
          sockets[0],
          "realtime:note:sync",
          { selector, schemaVersion: 1, stateVector: Y.encodeStateVector(doc) },
          WS_ACK_TIMEOUT_MS,
        );
        epoch = ack.epoch;
        Y.applyUpdate(doc, new Uint8Array(ack.update));
      } catch {
        await delay(500);
      }
    }

    if (epoch === 0) {
      result.note = "FALLBACK: heartbeat ack round-trip, NOT end-to-end propagation";
      result.measuredSomethingElse = true;
      for (let index = 0; index < WS_SAMPLES; index += 1) {
        const started = performance.now();
        await emitAck(sockets[0], "realtime:heartbeat", { sequence: index }, WS_ACK_TIMEOUT_MS);
        result.samples.push(performance.now() - started);
      }
      return result;
    }

    const reader = sockets[1];
    for (let index = 0; index < WS_SAMPLES; index += 1) {
      const update = await new Promise((capture) => {
        doc.once("update", capture);
        const paragraph = new Y.XmlElement("paragraph");
        doc.getXmlFragment("default").insert(0, [paragraph]);
        const text = new Y.XmlText();
        paragraph.insert(0, [text]);
        text.insert(0, `perf ${index}`);
      });

      const received = new Promise((settle, fail) => {
        const timer = setTimeout(() => fail(new Error("no remote frame within 5 s")), 5_000);
        reader.once("realtime:note:remote", () => {
          clearTimeout(timer);
          settle(performance.now());
        });
      });

      const started = performance.now();
      const [ack, arrived] = await Promise.all([
        emitAck(sockets[0], "realtime:note:update", { selector, epoch, update }, WS_ACK_TIMEOUT_MS),
        received,
      ]);
      // The server owns the epoch; carrying a stale one makes the next update
      // `stale` and resets the document mid-measurement.
      epoch = ack.epoch;
      result.samples.push(arrived - started);
    }
    return result;
  } catch (error) {
    result.errors += 1;
    result.note = String(error.message).slice(0, 120);
    return result;
  } finally {
    for (const socket of sockets) socket.close();
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    throw new Error(`No fixture at ${STATE_FILE}. Run \`node scripts/perf-bench.mjs seed\` first.`);
  }
}

async function run() {
  const budgets = JSON.parse(await readFile(join(here, "perf-budgets.json"), "utf8"));
  const state = await loadState();
  const ctx = {
    ...environment(),
    apiUrl: state.apiUrl,
    appUrl: state.appUrl,
    cookie: state.cookie,
  };
  const workspace = `/api/v1/workspaces/${state.workspaceId}`;
  const searchTerms = [SEARCH_TOKEN, `${SEARCH_TOKEN} note`, `${SEARCH_TOKEN} spine`];

  const results = {
    // Recorded during `seed`: generating the fixture through the API *is* the
    // create measurement, so `run` never writes a second thousand notes.
    "api.notes.create": emptyResult({ samples: state.createSamples ?? [] }),
    "api.notes.list": await sampleHttp(ctx, SAMPLES, (index) =>
      call(ctx, "GET", `${workspace}/notes?limit=100&page=${(index % 10) + 1}`),
    ),
    // THE LARGEST LIST IN THE PRODUCT, and the one the Part 77 audit originally
    // missed by asserting every list was capped at 100 rows. The dashboard's
    // sidebar tree is not: `getServerNoteNavigation`
    // (apps/web/src/lib/notes/server-notes.ts) requests `limit=500` against a
    // schema that permits 1000, and `NoteTree` renders the whole response on
    // every dashboard page. Sampled with the exact query string the server
    // component sends, so the number describes the real navigation, not a
    // convenient smaller one.
    "api.notes.navigation": await sampleHttp(ctx, SAMPLES, () =>
      call(ctx, "GET", `${workspace}/notes/navigation?limit=500&includeArchived=false`),
    ),
    "api.notes.read": await sampleHttp(ctx, SAMPLES, (index) =>
      call(
        ctx,
        "GET",
        // Every fifth read is the ~200 KB document, so the p95 reflects the
        // large-document case instead of hiding it behind small rows.
        `${workspace}/notes/${index % 5 === 0 ? state.largeNoteId : state.noteIds[index % state.noteIds.length]}`,
      ),
    ),
    "api.tasks.list": await sampleHttp(ctx, SAMPLES, (index) =>
      call(
        ctx,
        "GET",
        `${workspace}/tasks?limit=100&status=${TASK_STATUSES[index % TASK_STATUSES.length]}`,
      ),
    ),
    "api.search": await sampleHttp(ctx, SAMPLES, (index) =>
      call(
        ctx,
        "GET",
        `${workspace}/search?query=${encodeURIComponent(searchTerms[index % searchTerms.length])}&limit=100`,
      ),
    ),
    "ws.propagation": await sampleRealtime(state),
    "job.export.wait": await sampleExports(ctx, state),
    "bulk.upload": emptyResult({
      skipped: `${SKIPPED_BULK_UPLOAD.files} x ${SKIPPED_BULK_UPLOAD.bytesEach / 1024 / 1024} MiB not attempted. ${SKIPPED_BULK_UPLOAD.reason}`,
    }),
    "web.firstLoadJs": emptyResult({
      skipped:
        "build-time budget, currently unreadable: Next 16.2.11 prints no First Load JS column and its " +
        "Turbopack output has no app-build-manifest.json to derive one from",
    }),
    "editor.inputLatency": emptyResult(),
    "web.interactionLatency": emptyResult(),
    "web.firstLoadRuntime": emptyResult(),
  };

  process.stdout.write(
    `\nFixture: ${state.notes} notes, ${state.tasks} tasks, ${state.indexed} indexed`,
  );
  process.stdout.write(` (seeded ${state.seededAt})\n`);
  process.stdout.write(`Target: ${state.apiUrl}\n`);
  process.stdout.write(`Budget host: ${budgets.host}\n\n`);
  process.stdout.write(`${renderTable(results, budgets)}\n`);

  const failed = Object.entries(results).filter(([id, result]) =>
    ["FAIL", "VOID"].includes(evaluateStatus(result, budgets.scenarios[id])),
  );
  if (failed.length > 0) {
    process.stdout.write(`\n${failed.length} scenario(s) FAIL or VOID.\n`);
    process.exitCode = 1;
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.command === "seed") await seed(options);
  else await run();
}

// Importable without executing: scripts/perf-bench.test.mjs asserts on the pure
// helpers above and must never dial anything.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
