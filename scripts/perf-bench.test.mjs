import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_NOTES,
  MAX_TASKS,
  environment,
  MIN_SAMPLES,
  TABLE_HEADER,
  corpusPageSettled,
  corpusProbe,
  emptyResult,
  largeDocument,
  evaluateStatus,
  formatRow,
  parseArguments,
  percentile,
} from "./perf-bench.mjs";

const budgets = JSON.parse(
  readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url))), "perf-budgets.json"), "utf8"),
);

/** Twenty identical samples: `MIN_SAMPLES` is met and the p95 is exactly `value`. */
function samplesAt(value) {
  return emptyResult({ samples: Array.from({ length: MIN_SAMPLES }, () => value) });
}

test("percentile is nearest-rank and never interpolates", () => {
  // 1..20: rank ceil(0.95 * 20) = 19, so the nineteenth value, 19 — NOT 19.05,
  // which is what a linear-interpolation percentile would report.
  const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile(twenty, 0.95), 19);
  assert.equal(percentile(twenty, 0.5), 10);
  assert.equal(percentile(twenty, 0), 1);
  assert.equal(percentile(twenty, 1), 20);

  // Unsorted input must give the same answer as sorted input.
  assert.equal(percentile([9, 1, 5, 3, 7], 0.5), 5);

  // Degenerate sizes: n=1 is the only sample, n=2 is the larger of the two.
  assert.equal(percentile([42], 0.95), 42);
  assert.equal(percentile([42], 0), 42);
  assert.equal(percentile([10, 20], 0.95), 20);
  assert.equal(percentile([20, 10], 0.95), 20);

  assert.equal(percentile([], 0.95), null);
});

test("the budget comparator passes at exactly the budget and fails one above it", () => {
  const spec = { p95Ms: 200 };
  assert.equal(evaluateStatus(samplesAt(200), spec), "PASS");
  assert.equal(evaluateStatus(samplesAt(201), spec), "FAIL");
  assert.equal(evaluateStatus(samplesAt(199), spec), "PASS");
});

test("errors, rate limits, and thin sample sets void a scenario instead of scoring it", () => {
  const spec = { p95Ms: 200 };
  const errored = emptyResult({ samples: [1, 2, 3], errors: 1 });
  assert.equal(evaluateStatus(errored, spec), "VOID");

  // A 429 is a void run, not a slow one — it must never be reported as FAIL.
  const limited = emptyResult({ samples: samplesAt(10).samples, rateLimited: 1 });
  assert.equal(evaluateStatus(limited, spec), "VOID");

  const thin = emptyResult({ samples: Array.from({ length: MIN_SAMPLES - 1 }, () => 10) });
  assert.equal(evaluateStatus(thin, spec), "VOID");

  assert.equal(evaluateStatus(emptyResult({ skipped: "no MinIO here" }), spec), "SKIPPED");
});

test("a scenario that fell back to measuring something else is never scored", () => {
  // The realtime fallback samples a heartbeat round-trip, which is fast and is
  // not propagation. A comfortable PASS here would certify a budget nobody met.
  const fallback = emptyResult({
    samples: samplesAt(40).samples,
    measuredSomethingElse: true,
    note: "FALLBACK: heartbeat ack round-trip, NOT end-to-end propagation",
  });
  assert.equal(evaluateStatus(fallback, { p95Ms: 1000 }), "NOT MEASURED");
  assert.match(formatRow("ws.propagation", fallback, { p95Ms: 1000 }), /NOT MEASURED/u);
});

test("a null budget reports NOT MEASURED rather than a NaN latency", () => {
  const spec = { p95Ms: null, why: "blocked on a production web build" };
  const row = formatRow("editor.inputLatency", emptyResult(), spec);

  assert.equal(evaluateStatus(emptyResult(), spec), "NOT MEASURED");
  assert.match(row, /NOT MEASURED/u);
  assert.equal(row.includes("NaN"), false, `NaN leaked into a results row: ${row}`);
  assert.equal(row.includes("undefined"), false, `undefined leaked into a results row: ${row}`);
  // Empty cells read as em dashes, not as zero — a zero is a measurement.
  assert.match(row, /\| — \| — \| — \| — \|/u);

  // A populated row still prints numbers, so the em dash above is not universal.
  const measured = formatRow("api.notes.list", samplesAt(120), { p95Ms: 200 });
  assert.match(measured, /\| 120 \| 120 \| 120 \| 120 \|/u);
  assert.match(measured, /PASS/u);
});

test("every row has as many cells as the header declares", () => {
  const columns = TABLE_HEADER.split("\n")[0].split("|").length;
  for (const row of [
    formatRow("api.search", samplesAt(50), budgets.scenarios["api.search"]),
    formatRow(
      "web.firstLoadJs",
      emptyResult({ skipped: "build-time" }),
      budgets.scenarios["web.firstLoadJs"],
    ),
    formatRow("unbudgeted", emptyResult(), undefined),
  ]) {
    assert.equal(row.split("|").length, columns, row);
  }
});

test("--notes/--tasks clamp to the ceilings rather than being rejected", () => {
  assert.deepEqual(parseArguments(["seed"]), { command: "seed", notes: 1000, tasks: 2000 });
  assert.deepEqual(parseArguments(["seed", "--notes=500", "--tasks=750"]), {
    command: "seed",
    notes: 500,
    tasks: 750,
  });

  const clamped = parseArguments([
    "seed",
    `--notes=${MAX_NOTES * 10}`,
    `--tasks=${MAX_TASKS * 10}`,
  ]);
  assert.equal(clamped.notes, MAX_NOTES);
  assert.equal(clamped.tasks, MAX_TASKS);

  assert.equal(parseArguments(["seed", `--notes=${MAX_NOTES}`]).notes, MAX_NOTES);
  assert.throws(() => parseArguments(["seed", "--notes=0"]), /positive integer/u);
  assert.throws(() => parseArguments(["seed", "--notes=lots"]), /positive integer/u);
  assert.throws(() => parseArguments(["benchmark"]), /Unknown command/u);
  assert.throws(() => parseArguments(["run", "-n"]), /Unrecognized argument/u);
  // `run` measures whatever `seed` built; a fixture flag there is a mistake to
  // report, not a value to ignore.
  assert.throws(() => parseArguments(["run", "--notes=500"]), /only applies to "seed"/u);
  assert.throws(() => parseArguments(["run", "--tasks=10"]), /only applies to "seed"/u);
});

test("the three web budgets that need a production build stay null with a stated blocker", () => {
  for (const id of ["editor.inputLatency", "web.interactionLatency", "web.firstLoadRuntime"]) {
    const spec = budgets.scenarios[id];
    assert.notEqual(spec, undefined, `${id} is missing from perf-budgets.json`);
    assert.equal(spec.p95Ms, null, `${id} must stay null until a production web build exists`);
    assert.match(spec.why, /BLOCKED/u, `${id} must name its blocker`);
  }
});

test("every measured budget is a positive number carrying a justification", () => {
  for (const [id, spec] of Object.entries(budgets.scenarios)) {
    assert.equal(typeof spec.why, "string", `${id} has no justification`);
    assert.ok(spec.why.length > 40, `${id}'s justification is too thin to be one`);
    if (spec.p95Ms !== null) {
      assert.ok(Number.isFinite(spec.p95Ms) && spec.p95Ms > 0, `${id} has a nonsense budget`);
    }
  }
});

test("corpusProbe asks a question only a filled index can answer", () => {
  // 1000 notes + the one large document, but the search API stops authorizing
  // after MAX_CANDIDATES (200), so page 2 of 100 is the deepest page it can ever
  // fill and nothing lies beyond it.
  assert.deepEqual(corpusProbe(1001), { page: 2, limit: 100, total: 100, hasMore: false });

  // The bug this replaces polled `limit=1&page=1`, where `total` is 1 from the
  // moment the FIRST document lands — `SearchPage.total` counts the items on
  // this page, not the corpus.
  assert.deepEqual(corpusProbe(1001, 1), { page: 200, limit: 1, total: 1, hasMore: false });

  // Smaller fixtures stay correct: no full page exists, so page 1 is probed and
  // the predicate becomes the whole corpus with nothing beyond it.
  assert.deepEqual(corpusProbe(51), { page: 1, limit: 100, total: 51, hasMore: false });

  // The ceiling is a parameter so the arithmetic itself stays testable: raise it
  // and the probe walks deeper, exactly as it would if MAX_CANDIDATES moved.
  assert.deepEqual(corpusProbe(1001, 100, 1000), {
    page: 10,
    limit: 100,
    total: 100,
    hasMore: false,
  });
  assert.deepEqual(corpusProbe(1001, 100, 10_000), {
    page: 10,
    limit: 100,
    total: 100,
    hasMore: true,
  });
});

test("corpusPageSettled rejects a half-indexed page", () => {
  const probe = corpusProbe(1001);
  assert.equal(corpusPageSettled(probe, { total: 100, hasMore: false }), true);
  // Still filling: the deepest page is short.
  assert.equal(corpusPageSettled(probe, { total: 43, hasMore: false }), false);
  // The old `limit=1` predicate's failure mode, stated as a case: one item on a
  // page is not evidence of anything.
  assert.equal(corpusPageSettled(probe, { total: 1, hasMore: false }), false);
  // A malformed or errored body is not "settled".
  assert.equal(corpusPageSettled(probe, undefined), false);
  assert.equal(corpusPageSettled(probe, {}), false);
});

test("every budget scenario is one the harness can name", () => {
  // Guards the H5 addition against drift: a budget with no scenario is a
  // promise nothing measures, which is how `api.notes.navigation` went missing
  // in the first place.
  assert.ok(Object.hasOwn(budgets.scenarios, "api.notes.navigation"));
  assert.equal(typeof budgets.scenarios["api.notes.navigation"].p95Ms, "number");
  assert.ok(budgets.scenarios["api.notes.navigation"].why.length > 80);
});

test("the large-document fixture stays inside every note-schema limit", () => {
  // The limits are literals here on purpose: this file must run with
  // `node --test` and no build step, and `@notted/shared-validators` is a
  // TypeScript package. Source of truth: NOTE_DOCUMENT_LIMITS in
  // packages/shared-validators/src/document.schema.ts.
  const doc = largeDocument();
  const MAX_CHILDREN = 200;
  const MAX_TOTAL_TEXT = 200_000;
  const MAX_SERIALIZED_BYTES = 512_000;
  const MAX_STRING = 20_000;

  // `maxChildren` is the one that actually bit: the fixture was 380 paragraphs
  // on one `doc` node, sized against `maxTotalText` alone, and every `seed` run
  // died on `POST /notes` with a bare VALIDATION_ERROR before measuring anything.
  assert.ok(
    doc.content.length <= MAX_CHILDREN,
    `doc has ${doc.content.length} children, limit ${MAX_CHILDREN}`,
  );

  const texts = doc.content.map((paragraph) => paragraph.content[0].text);
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  assert.ok(total <= MAX_TOTAL_TEXT, `total text ${total}, limit ${MAX_TOTAL_TEXT}`);
  assert.ok(Math.max(...texts.map((text) => text.length)) <= MAX_STRING);
  assert.ok(JSON.stringify(doc).length <= MAX_SERIALIZED_BYTES);

  // Still worth calling large: a fixture that shrank to nothing would satisfy
  // every assertion above and measure the wrong thing.
  assert.ok(total > 150_000, `large document is only ${total} characters`);
});

test("Mailpit default follows the checkout's published host port", () => {
  const original = {
    url: process.env.PERF_MAILPIT_URL,
    port: process.env.NOTTED_MAILPIT_WEB_PORT,
  };
  try {
    delete process.env.PERF_MAILPIT_URL;

    delete process.env.NOTTED_MAILPIT_WEB_PORT;
    assert.equal(environment().mailpitUrl, "http://localhost:8025");

    // The reason this exists: this repo's own `.env` shifts Mailpit to 8125
    // because another project holds 8025, and the old hard-coded default sent
    // every reviewer to a dead port.
    process.env.NOTTED_MAILPIT_WEB_PORT = "8125";
    assert.equal(environment().mailpitUrl, "http://localhost:8125");

    process.env.PERF_MAILPIT_URL = "http://mail.example.test";
    assert.equal(environment().mailpitUrl, "http://mail.example.test");
  } finally {
    if (original.url === undefined) delete process.env.PERF_MAILPIT_URL;
    else process.env.PERF_MAILPIT_URL = original.url;
    if (original.port === undefined) delete process.env.NOTTED_MAILPIT_WEB_PORT;
    else process.env.NOTTED_MAILPIT_WEB_PORT = original.port;
  }
});
