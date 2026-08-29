import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  API_URL,
  APP_URL,
  createWorkspace,
  identity,
  registerAndSignIn,
  type Account,
} from "./accounts";
import { PRINT_HIDDEN_SELECTORS } from "./print-selectors";

/**
 * Part 76 item 5: the small set of behaviours that a second browser engine can
 * actually falsify.
 *
 * Every other spec in this directory runs on chromium, because `dev-tooling.mjs`
 * injects `--project=chromium` unless the caller names a project. That is the
 * right default — but it means the whole suite is evidence about Blink only,
 * and a contenteditable editor is built on exactly the primitives where Gecko
 * and WebKit diverge from Blink: `beforeinput` sequencing, IME composition,
 * `Selection` and range normalisation, and whether a synthetic `ClipboardEvent`
 * can even carry its `clipboardData`. A TipTap document is not a controlled
 * `<input>`; it is those four primitives wearing a schema.
 *
 * So this file exists to be run explicitly, always with its own spec path and
 * never as part of a whole-suite run in a second engine (`docs/standards/
 * testing.md` → Cross-browser runs states the rule and the reason):
 *
 *     pnpm e2e:test --project=firefox e2e/cross-browser.spec.ts
 *     pnpm e2e:test --project=webkit  e2e/cross-browser.spec.ts
 *
 * and it is deliberately tiny. The local resource budget (see `CLAUDE.md` →
 * End-to-end runs) forbids replaying a 7–13 minute serial suite in a second
 * engine; what it affords is one short pass over the primitives, which is where
 * the divergence lives anyway. Re-proving business logic in Gecko buys nothing —
 * the tRPC layer is engine-independent.
 *
 * It also runs under the default chromium project, where it is a canary: if
 * these five tests break in Blink, the cross-engine run is not worth starting.
 *
 * The clipboard, print and passkey tests each avoid a Chromium-only Playwright
 * API on purpose; the reason is recorded at each one, because "use the CDP
 * helper" is the obvious wrong fix in every case.
 */

const disposable = process.env.PLAYWRIGHT_DISPOSABLE_TEST_RUN === "true";

/** Generous enough for a cold Next dev-server route compile. */
const ROUTE_COMPILE_MS = 45_000;

/**
 * Re-establishes the seeded session in a fresh page's cookie jar.
 *
 * API rather than the login form: `auth.spec.ts` owns the form, and a spec
 * about editor primitives should not spend browser time re-proving it. The
 * cookie lands in the context's jar either way.
 */
async function signIn(page: Page, account: Account): Promise<void> {
  const response = await page.request.post(`${API_URL}/api/auth/sign-in/email`, {
    headers: { Origin: APP_URL },
    data: { email: account.email, password: account.password, rememberMe: false },
  });
  expect(response.ok(), `sign-in → ${response.status()}`).toBe(true);
}

/**
 * The Reflow invariant: the document never scrolls sideways.
 *
 * `+ 1` absorbs sub-pixel rounding, which differs per engine — the one place
 * this file has to be tolerant precisely because it is cross-engine.
 */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

test.describe.serial("Part 76 cross-engine editor primitives", () => {
  test.skip(
    !disposable,
    "cross-browser verification requires PLAYWRIGHT_DISPOSABLE_TEST_RUN=true and disposable PostgreSQL, Redis, and Mailpit",
  );

  const account = identity("Cross Engine");
  const typed = `Typed in this engine ${randomUUID().slice(0, 8)}.`;

  let workspaceId = "";
  let noteId = "";
  let notePath = "";

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await registerAndSignIn(page, account);
      workspaceId = await createWorkspace(page, `Cross engine ${randomUUID().slice(0, 8)}`);

      const created = await page.request.post(`${API_URL}/api/v1/workspaces/${workspaceId}/notes`, {
        headers: { Origin: APP_URL, "Idempotency-Key": randomUUID() },
        data: { title: "Cross-engine note", projectId: null, folderId: null, parentId: null },
      });
      expect(created.ok(), `note create → ${created.status()}`).toBe(true);
      const body = (await created.json()) as { note: { id: string } };
      noteId = body.note.id;
      notePath = `/workspaces/${workspaceId}/notes/${noteId}`;
    } finally {
      await context.close();
    }
  });

  test("keyboard input into the contenteditable surface reaches the persisted note", async ({
    page,
  }) => {
    await signIn(page, account);
    await page.goto(notePath);

    const body = page.getByRole("textbox", { name: /Note content/u });
    await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    await body.click();
    await page.keyboard.type(typed);

    /*
     * Explicitly NOT the save indicator. `NoteEditorSurface` binds one writer at
     * a time, and on a synced collaborative session that writer is the server's
     * Yjs projection — the Part 39 autosave machine is deliberately left
     * unbound, so its indicator reads "No unsaved changes." from the first
     * paint and never moves. Waiting on it would be waiting on a control that
     * cannot change. The persisted row is the thing the indicator was only ever
     * standing in for, so poll that.
     *
     * The timeout is generous rather than a sleep because the projection lands
     * `notes.content` on a trailing debounce: the wait is for a real event with
     * an unknown arrival time, and it ends the moment the event happens.
     */
    await expect
      .poll(
        async () => {
          const detail = await page.request.get(
            `${API_URL}/api/v1/workspaces/${workspaceId}/notes/${noteId}`,
            { headers: { Origin: APP_URL } },
          );
          expect(detail.ok(), `note fetch → ${detail.status()}`).toBe(true);
          const payload = (await detail.json()) as { content?: unknown };
          return JSON.stringify(payload.content ?? null);
        },
        { timeout: 45_000, intervals: [500, 1_000, 2_000] },
      )
      .toContain(typed);
  });

  test("a paste carrying HTML is parsed into schema nodes", async ({ page }) => {
    await signIn(page, account);
    await page.goto(notePath);

    const body = page.getByRole("textbox", { name: /Note content/u });
    await expect(body).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    // Click first: ProseMirror's paste handler reads the current selection, and
    // a document with no selection swallows the event. This is also the step
    // that differs by engine — the click has to produce a real `Selection`.
    await body.click();

    /*
     * Deliberately NOT `context.grantPermissions(["clipboard-read"])`: that
     * permission name exists only in Chromium, so requesting it throws in
     * Firefox and WebKit and would turn the cross-engine test into a
     * Chromium-only one. Deliberately NOT a real Ctrl+C / Ctrl+V through the OS
     * clipboard either: headless WebKit has no reliable clipboard backing store
     * and that path flakes. A synthesised `ClipboardEvent` tests the thing this
     * file is about — whether the app's own paste handler runs and parses — and
     * whether the engine can construct one at all is itself a finding.
     *
     * `<p><strong>…</strong></p>` maps onto StarterKit's paragraph and bold,
     * both unconditionally enabled in `note-editor-extensions.ts`, so a missing
     * `<strong>` means the paste was dropped, never that the schema stripped it.
     */
    const delivered = await page.locator(".notted-editor-content").evaluate((surface) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/html", "<p><strong>Pasted bold</strong></p>");
      // A capture listener on the same element runs before ProseMirror's own
      // handler and does not consume the event, so it reports what the ENGINE
      // handed the application rather than what the test asked for.
      let seen: string | null = null;
      const probe = (event: Event): void => {
        seen = (event as ClipboardEvent).clipboardData?.getData("text/html") ?? null;
      };
      surface.addEventListener("paste", probe, { capture: true });
      surface.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      surface.removeEventListener("paste", probe, { capture: true });
      return seen;
    });

    /*
     * The engine-capability finding this test's header anticipates, now measured
     * rather than assumed. Gecko does not let page script attach payload to a
     * synthesised `ClipboardEvent`: the constructor accepts `clipboardData` and
     * the delivered event carries an EMPTY one, so the application's paste
     * handler is invoked with nothing to parse. There is no user-gesture route
     * around it either — the alternatives are a real OS clipboard (no reliable
     * headless backing store) or `clipboard-read`, a permission name that exists
     * only in Chromium.
     *
     * So this is stated as a capability gate rather than smuggled into a weaker
     * assertion: on an engine that delivers the payload the parse is asserted in
     * full, and on one that does not the run says which engine and why instead
     * of quietly passing. The application code under test is engine-independent;
     * what differs is the harness's ability to synthesise the input.
     */
    test.skip(
      delivered === null || delivered === "",
      `${test.info().project.name} delivered no clipboardData on a synthesised ClipboardEvent ` +
        `(got ${JSON.stringify(delivered)}); the app's paste handler cannot be driven from page ` +
        `script on this engine.`,
    );

    await expect(page.locator(".notted-editor-content strong")).toContainText("Pasted bold");
  });

  test("print media hides every piece of chrome and keeps the sheet laid out", async ({ page }) => {
    await signIn(page, account);
    await page.goto(notePath);

    const paper = page.getByTestId("notted-page-paper");
    await expect(paper).toBeVisible({ timeout: ROUTE_COMPILE_MS });
    const screenWidth = await paper.evaluate((element) => element.getBoundingClientRect().width);
    expect(screenWidth).toBeGreaterThan(0);

    /*
     * `page.pdf()` is Chromium-only — `export-formats.spec.ts` carries the
     * `test.skip(browserName !== "chromium", …)` for exactly that reason — so
     * the printed *bytes* are unavailable here by construction. What every
     * engine can be asked is whether `print.css` applies at all under
     * `media: print`, which is the part that has ever regressed.
     */
    await page.emulateMedia({ media: "print" });
    try {
      for (const selector of PRINT_HIDDEN_SELECTORS) {
        const chrome = page.locator(selector);
        // A selector with no match is not evidence of a leak: not every route
        // paints every piece of chrome. Same treatment as `print-export.spec.ts`.
        if ((await chrome.count()) === 0) continue;
        await expect(chrome.first(), `${selector} was still painted in print`).toBeHidden();
      }

      /*
       * The sheet itself must survive. Not a width *equality* check: `print.css`
       * forces `width: auto` and `transform: none` on `.notted-page-paper` on
       * purpose — zoom is a screen affordance and the printed sheet is always
       * 100% — so the print width is the flow width, not the scaled screen box,
       * and asserting parity would assert against the stylesheet's intent. The
       * regression worth catching is collapse: a paper that the print rules
       * shrink to nothing takes the note's text with it.
       */
      const printWidth = await paper.evaluate((element) => element.getBoundingClientRect().width);
      expect(printWidth).toBeGreaterThan(0);
      expect(printWidth).toBeGreaterThan(screenWidth / 2);
      await expect(page.locator(".notted-editor-content")).toBeVisible();
    } finally {
      await page.emulateMedia({ media: null });
    }
  });

  test("reduced motion, reflow at 390px, and 200% zoom at 1440px", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page, account);

    try {
      /*
       * WCAG 2.2 SC 1.4.10 Reflow is stated at a 320 CSS px equivalent, and the
       * two viewports below are the two honest ways to reach it: 390 at 100%,
       * and 1440 at 200% (= 720 px equivalent, comfortably past it).
       *
       * Zoom is applied ONLY to the 1440 case, and that is load-bearing rather
       * than arbitrary. `body` carries `min-width: 320px` in `globals.css`; 390
       * CSS px at 200% is a 195 px equivalent viewport, so that floor guarantees
       * horizontal overflow there. The floor is the stylesheet's deliberate
       * lower bound, not a defect, and it sits below the 320 px the success
       * criterion actually asks for — which is why the never-executed zoom test
       * in the former `dashboard-shell.spec.ts` was not simply copied here.
       *
       * "At 200%" is expressed as a 720 px viewport rather than as CSS `zoom`;
       * see the comment at that step for the measurement behind that choice.
       */
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/workspaces/${workspaceId}`);
      await expect(page.getByRole("main")).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      expect(
        await horizontalOverflow(page),
        "the page scrolled sideways at 390px",
      ).toBeLessThanOrEqual(1);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/workspaces/${workspaceId}`);
      await expect(page.getByRole("main")).toBeVisible({ timeout: ROUTE_COMPILE_MS });
      expect(
        await horizontalOverflow(page),
        "the page scrolled sideways at 1440px",
      ).toBeLessThanOrEqual(1);

      /*
       * 200% zoom, expressed the only way an engine actually honours.
       *
       * The obvious `document.documentElement.style.zoom = "200%"` does NOTHING:
       * measured in this Chromium it leaves the computed value at `1` and the
       * root `clientWidth` at 1440 — CSS `zoom` on the root element is ignored,
       * because it would fight the browser's own zoom. So the assertion that
       * used to follow it was not "200% zoom reflows"; it was the 100% case run
       * a second time.
       *
       * Browser zoom scales the CSS pixel, so 1440 device px at 200% IS a 720
       * CSS px viewport — the same number, arrived at honestly and identically
       * in all three engines. It is still comfortably past SC 1.4.10's 320 px
       * equivalent, which is the point of choosing 1440 as the base.
       */
      await page.setViewportSize({ width: 720, height: 900 });
      await expect(page.getByRole("main")).toBeVisible();
      expect(
        await horizontalOverflow(page),
        "the page scrolled sideways at the 720px CSS equivalent of 1440px @ 200%",
      ).toBeLessThanOrEqual(1);

      /*
       * `prefers-reduced-motion` is emulated for this whole test, but nothing
       * above depended on it: reflow is the same at either setting, so deleting
       * every `@media (prefers-reduced-motion: reduce)` block in `globals.css`
       * would leave this test green. This asserts the media query itself.
       *
       * The probe declares a 2 s animation and transition INLINE. The base
       * stylesheet's reduced-motion block is `*, *::before, *::after { … 0.01ms
       * !important }`, and an `!important` author declaration outranks a normal
       * inline one — so if the block is present the probe computes to
       * effectively zero, and if it is removed the probe keeps its 2 s. A bare
       * element would prove nothing: almost everything already computes to `0s`
       * with no rule involved at all.
       */
      const motion = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.animationName = "notted-cross-browser-probe";
        probe.style.animationDuration = "2s";
        probe.style.transitionProperty = "opacity";
        probe.style.transitionDuration = "2s";
        document.body.append(probe);
        const computed = getComputedStyle(probe);
        const durations = {
          animation: computed.animationDuration,
          transition: computed.transitionDuration,
        };
        probe.remove();
        return durations;
      });
      const milliseconds = (value: string): number => {
        const match = /^\s*(-?[\d.]+(?:e[+-]?\d+)?)(ms|s)\s*$/iu.exec(value);
        return match === null ? Number.NaN : Number(match[1]) * (match[2] === "ms" ? 1 : 1000);
      };
      expect(
        milliseconds(motion.animation),
        `prefers-reduced-motion did not suppress animation (${motion.animation})`,
      ).toBeLessThan(1);
      expect(
        milliseconds(motion.transition),
        `prefers-reduced-motion did not suppress transitions (${motion.transition})`,
      ).toBeLessThan(1);
    } finally {
      // The `page` fixture is per-test, but a serial describe is exactly where a
      // leaked emulation would be blamed on the next test instead of this one.
      await page.emulateMedia({ reducedMotion: null });
    }
  });

  test("the passkey control degrades instead of throwing without PublicKeyCredential", async ({
    page,
  }) => {
    /*
     * Only the degradation path is asserted here. Real passkey registration
     * needs Playwright's virtual authenticator, which is driven over CDP and so
     * exists in Chromium alone; that coverage stays in `advanced-auth.spec.ts`,
     * where it belongs. What every engine can be asked is the question that
     * actually matters cross-engine: does a browser without WebAuthn get a
     * usable, explained login screen, or a thrown error?
     *
     * `advanced-sign-in-methods.tsx` resolves `passkeySupport` to "unsupported"
     * when `PublicKeyCredential` is absent, which disables the button and
     * renders the explanation — so deleting the global reproduces the real
     * browser exactly, without needing one.
     *
     * The control renders only when the server reports
     * `capabilities.passkeyEnabled`; `advanced-auth.spec.ts` already depends on
     * it being enabled in this stack, so a skip here would only hide a stack
     * misconfiguration.
     */
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "PublicKeyCredential");
    });
    await page.goto("/login");

    await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeDisabled({
      timeout: ROUTE_COMPILE_MS,
    });
    await expect(page.getByText(/Passkeys require a supported browser/u)).toBeVisible();
  });
});
