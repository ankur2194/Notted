// Part 69 — reading a JSON document a language model wrote.
//
// A MODEL IS NOT A JSON ENCODER. It is a text generator that has been asked
// very firmly for JSON, and it complies almost always: the failures are a
// markdown fence wrapped around an otherwise perfect object, a trailing
// sentence of commentary, or one field of the wrong shape. Treating those as a
// 500 would fail a feature that is one re-prompt away from working, and
// accepting them unvalidated would let model output become response payload.
// So: strip, parse, validate; on failure re-prompt ONCE with the schema's own
// complaint; on a second failure give up with a stable 422.
//
// EXACTLY ONE REPAIR, AND THIS MODULE MAKES NO PROVIDER CALL ITSELF. The
// `repair` callback is the caller's second provider call, which is what makes
// "at most two provider calls per request" a property of the code rather than
// of a comment — there is no loop here to bound, no retry budget to misconfigure.
//
// THE FEEDBACK STRING IS BUILT FROM ZOD ISSUES, NEVER FROM MODEL TEXT. `issue`
// is interpolated into the repair prompt, so anything a model could have
// written into it would be a second injection surface one hop past the
// `<transcript>` delimiter. Paths, codes and the schema's own messages are all
// authored in this repository; the raw output is echoed back only inside a
// stripped `<invalid_output>` delimiter by the prompt builder, never here.
//
// NOTHING IS LOGGED. `raw`, `previousOutput` and the parsed value are all note
// or transcript content by construction (ADR 0007 keeps that out of logs), so
// this module has no logger and no branch that could grow one.

import { HttpStatus } from "@nestjs/common";

import { ApiHttpException } from "../common/errors/api-http.exception";

import type { ZodError, ZodType, output as ZodOutput } from "zod";

/**
 * A fenced block, which is the one formatting mistake worth correcting in
 * process rather than by re-prompting: ```json … ``` and ``` … ``` both.
 *
 * A newline after the opening fence is required, because that is what every
 * provider emits and because a lazier pattern starts eating one-line objects
 * that merely contain backticks. Anything that does not match falls through to
 * the trimmed text, where `JSON.parse` gets the final say.
 */
const JSON_FENCE = /^```(?:[A-Za-z][A-Za-z0-9+-]*)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/u;

/** Enough for a reader (and a model) to see what was wrong; short enough to re-prompt cheaply. */
const MAX_ISSUE_CHARS = 500;

/** The rejected reply is echoed back for correction, not reproduced in full. */
const MAX_ECHOED_OUTPUT_CHARS = 4_000;

/** How many separate complaints are worth stating; the rest are the same mistake. */
const MAX_REPORTED_ISSUES = 5;

export function stripJsonFences(raw: string): string {
  const trimmed = raw.trim();
  return (JSON_FENCE.exec(trimmed)?.[1] ?? trimmed).trim();
}

type Attempt<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issue: string };

/**
 * Parse and validate model output, re-prompting at most once.
 *
 * @param input.raw the model's reply, exactly as it arrived
 * @param input.schema the contract the reply must satisfy
 * @param input.repair the caller's second provider call; receives a
 *   schema-authored description of what was wrong and the (truncated) rejected
 *   reply, and resolves with the model's corrected text
 */
export async function parseJsonWithRepair<Schema extends ZodType>(input: {
  readonly raw: string;
  readonly schema: Schema;
  readonly repair: (issue: string, previousOutput: string) => Promise<string>;
}): Promise<ZodOutput<Schema>> {
  const first = attempt(input.raw, input.schema);
  if (first.ok) return first.value;

  const second = attempt(
    await input.repair(first.issue, truncate(input.raw, MAX_ECHOED_OUTPUT_CHARS)),
    input.schema,
  );
  if (second.ok) return second.value;

  // 422, not 502: the provider answered, the answer is unusable. The copy says
  // what the caller can do about it and nothing about what came back.
  throw new ApiHttpException(HttpStatus.UNPROCESSABLE_ENTITY, {
    code: "AI_OUTPUT_INVALID",
    message: "The AI provider returned a response this server could not read. Try again.",
  });
}

function attempt<Schema extends ZodType>(raw: string, schema: Schema): Attempt<ZodOutput<Schema>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    // Deliberately generic: the parser's own message quotes the input.
    return { ok: false, issue: "the output was not valid JSON" };
  }

  const result = schema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data as ZodOutput<Schema> }
    : { ok: false, issue: describeIssues(result.error) };
}

/**
 * Paths, codes and schema-authored messages only — see the file header on why
 * no model-written text may reach this string.
 */
function describeIssues(error: ZodError): string {
  const described = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.code} — ${issue.message}`;
    })
    .join("; ");
  return truncate(described.replace(/\s+/gu, " "), MAX_ISSUE_CHARS);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
