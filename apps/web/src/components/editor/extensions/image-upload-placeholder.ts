/**
 * In-flight image uploads, held as ProseMirror **decorations** (Part 42).
 *
 * ## Why decorations and not a `pending` node
 *
 * This is the load-bearing design decision of the whole part, and it is a
 * correctness decision rather than a stylistic one.
 *
 * A pending *node* would be part of `editor.getJSON()`. That means `onUpdate`
 * fires, `onDocumentChange` fires, and Part 39's autosave PATCHes a document
 * that references an attachment which does not exist yet. The API then has to
 * either accept dangling references — a tenant hazard, and the opposite of the
 * convention `projects.service.ts:567-577` sets — or reject the write. A
 * rejection arrives as `kind: "invalid"`, which the autosave machine correctly
 * treats as **non-retryable**: it parks in `error` *after* a broken document has
 * already been persisted, and the writer is told saving has stopped for a reason
 * they cannot act on.
 *
 * Decorations add **zero nodes**. `getJSON()` is byte-identical before and after
 * a placeholder appears, `onDocumentChange` is never called, autosave stays
 * exactly where it was, and `safeParseNoteDocument` has nothing to reject. The
 * `blob:` preview URL exists only inside a widget's DOM, which is why the saved
 * document can never depend on one.
 *
 * `DecorationSet.map(tr.mapping, tr.doc)` is the canonical mechanism for keeping
 * N placeholders anchored while the writer keeps typing around them — that is
 * precisely the Part 42 criterion "multiple concurrent uploads preserve
 * insertion positions", and it is implemented and tested as such.
 *
 * Completion is one ordinary transaction (insert the image node, drop the
 * decoration). Cancellation and failure produce **no document change at all**.
 */

import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import type {
  NoteDocumentAttachmentAttrs,
  NoteDocumentImageAttrs,
} from "@notted/shared-validators";
import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export const IMAGE_UPLOAD_PLACEHOLDER_KEY = new PluginKey<DecorationSet>(
  "nottedImageUploadPlaceholder",
);

export const IMAGE_UPLOAD_PLACEHOLDER_CLASS = "notted-image-upload";

/** Set on `view.dom` while an image drag is over the editor. */
export const IMAGE_DROP_ACTIVE_CLASS = "notted-image-drop-active";

export type ImagePlaceholderPhase = "queued" | "uploading" | "error";

export interface ImagePlaceholderState {
  readonly fileName: string;
  readonly phase: ImagePlaceholderPhase;
  /** `0`–`1`, or `null` for an indeterminate bar. */
  readonly progress: number | null;
  /** Announced politely; the only place upload state is reported in words. */
  readonly message: string;
  /** A local `blob:` preview. Never reaches the document — see the file header. */
  readonly previewUrl: string | null;
  readonly onCancel?: () => void;
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
}

/**
 * No `destroy` hook, deliberately — revoking the preview here would be a defect.
 *
 * `DecorationSet.map` mints a new `Decoration` for every transaction, and
 * `prosemirror-view`'s `placeWidget` only reuses a `WidgetViewDesc` when the
 * `Decoration` objects are *identical* or the widget DOM is unattached. A live
 * placeholder is attached, so the desc is torn down and rebuilt on **every**
 * document change: one typed character would revoke every in-flight `blob:` URL
 * and blank all the thumbnails while the uploads were still running.
 *
 * Revocation therefore belongs entirely to the upload manager, which owns the
 * lifecycle rather than the rendering: `forget()` on both terminal outcomes
 * (`removed` and `uploaded`) and `releaseAll()` on unmount. The registry keys
 * the URLs, so a repeat is a no-op rather than a double free.
 */
interface PlaceholderSpec {
  readonly nottedUploadId: string;
  readonly dom: HTMLElement;
  state: ImagePlaceholderState;
}

type PlaceholderAction =
  | {
      readonly type: "add";
      readonly id: string;
      readonly pos: number;
      readonly decoration: Decoration;
    }
  | { readonly type: "remove"; readonly id: string };

function specOf(decoration: Decoration): PlaceholderSpec | null {
  const spec: unknown = decoration.spec;
  if (typeof spec !== "object" || spec === null) return null;
  const candidate = spec as Partial<PlaceholderSpec>;
  return typeof candidate.nottedUploadId === "string" ? (candidate as PlaceholderSpec) : null;
}

function findDecoration(state: EditorState, id: string): Decoration | null {
  const set = IMAGE_UPLOAD_PLACEHOLDER_KEY.getState(state);
  if (set === undefined) return null;
  for (const decoration of set.find()) {
    if (specOf(decoration)?.nottedUploadId === id) return decoration;
  }
  return null;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `${IMAGE_UPLOAD_PLACEHOLDER_CLASS}__action`;
  element.textContent = label;
  // ProseMirror would otherwise move the selection on mousedown and steal the
  // click before the button ever sees it.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return element;
}

interface PlaceholderDom {
  readonly root: HTMLElement;
  readonly preview: HTMLImageElement;
  readonly name: HTMLElement;
  readonly bar: HTMLElement;
  readonly fill: HTMLElement;
  readonly status: HTMLElement;
  readonly actions: HTMLElement;
}

/**
 * Build the widget's DOM imperatively, following `Mention.ts`.
 *
 * The progress bar is hand-rolled: a single non-interactive bar does not justify
 * adding `@radix-ui/react-progress` (a new dependency, in a *non-React* widget),
 * and `role="progressbar"` with `aria-valuenow`/`aria-valuetext` is the complete
 * accessible contract for one.
 */
function createPlaceholderDom(): PlaceholderDom {
  const root = document.createElement("div");
  root.className = IMAGE_UPLOAD_PLACEHOLDER_CLASS;
  root.setAttribute("contenteditable", "false");
  root.setAttribute("role", "group");
  // Chrome, not content: never printed and never exported.
  root.setAttribute("data-notted-print-hide", "");

  const preview = document.createElement("img");
  preview.className = `${IMAGE_UPLOAD_PLACEHOLDER_CLASS}__preview`;
  // The status text below already names the file; the thumbnail is decorative.
  preview.alt = "";
  // `setAttribute`, matching `CustomImage.ts`: jsdom reflects the IDL property
  // but not the attribute, so the property form is untestable.
  preview.setAttribute("decoding", "async");

  const body = document.createElement("div");
  body.className = `${IMAGE_UPLOAD_PLACEHOLDER_CLASS}__body`;

  const name = document.createElement("p");
  name.className = `${IMAGE_UPLOAD_PLACEHOLDER_CLASS}__name`;

  const bar = document.createElement("div");
  bar.className = `${IMAGE_UPLOAD_PLACEHOLDER_CLASS}__bar`;
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");

  const fill = document.createElement("span");
  fill.className = `${IMAGE_UPLOAD_PLACEHOLDER_CLASS}__fill`;
  bar.append(fill);

  const status = document.createElement("p");
  status.className = `${IMAGE_UPLOAD_PLACEHOLDER_CLASS}__status`;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = `${IMAGE_UPLOAD_PLACEHOLDER_CLASS}__actions`;

  body.append(name, bar, status, actions);
  root.append(preview, body);
  return { root, preview, name, bar, fill, status, actions };
}

const DOM_CACHE = new WeakMap<HTMLElement, PlaceholderDom>();

/** Repaint one placeholder from its current state. Never rebuilds the DOM. */
export function paintPlaceholder(root: HTMLElement, state: ImagePlaceholderState): void {
  const dom = DOM_CACHE.get(root);
  if (dom === undefined) return;

  root.setAttribute("data-upload-phase", state.phase);
  root.setAttribute("aria-label", `Image upload: ${state.fileName}`);
  dom.name.textContent = state.fileName;
  dom.status.textContent = state.message;

  if (state.previewUrl === null) {
    dom.preview.removeAttribute("src");
    dom.preview.hidden = true;
  } else if (dom.preview.getAttribute("src") !== state.previewUrl) {
    dom.preview.hidden = false;
    dom.preview.setAttribute("src", state.previewUrl);
  }

  const showBar = state.phase !== "error";
  dom.bar.hidden = !showBar;
  if (showBar) {
    const percent = state.progress === null ? null : Math.round(state.progress * 100);
    if (percent === null) {
      // An indeterminate bar omits `aria-valuenow` rather than claiming zero.
      dom.bar.removeAttribute("aria-valuenow");
      dom.bar.setAttribute("aria-valuetext", "Waiting to upload");
      dom.fill.style.width = "0%";
    } else {
      dom.bar.setAttribute("aria-valuenow", String(percent));
      dom.bar.setAttribute("aria-valuetext", `${percent}%`);
      dom.fill.style.width = `${percent}%`;
    }
    dom.bar.setAttribute("aria-label", `Upload progress for ${state.fileName}`);
  }

  dom.actions.replaceChildren();
  if (state.onRetry !== undefined) dom.actions.append(button("Retry", state.onRetry));
  if (state.onCancel !== undefined) dom.actions.append(button("Cancel", state.onCancel));
  if (state.onDismiss !== undefined) dom.actions.append(button("Dismiss", state.onDismiss));
}

function createDecoration(id: string, pos: number, state: ImagePlaceholderState): Decoration {
  const dom = createPlaceholderDom();
  DOM_CACHE.set(dom.root, dom);
  const spec: PlaceholderSpec = { nottedUploadId: id, dom: dom.root, state };
  paintPlaceholder(dom.root, state);
  // `Object.assign` rather than a spread: the decoration's spec must be the very
  // object `update` mutates, so a rescued or re-mapped decoration keeps reading
  // live state rather than a stale copy taken at creation time.
  return Decoration.widget(
    pos,
    dom.root,
    Object.assign(spec, {
      // Placeholders belong after the caret at the insertion point, and a stable
      // `side` keeps a batch of them in a stable relative order.
      side: 1,
      // Never let a placeholder participate in the document's selection or
      // clipboard serialization; it is not content.
      ignoreSelection: true,
    }),
  );
}

function applyAction(
  set: DecorationSet,
  tr: Transaction,
  action: PlaceholderAction,
): DecorationSet {
  if (action.type === "add") return set.add(tr.doc, [action.decoration]);
  const existing = set
    .find()
    .filter((decoration) => specOf(decoration)?.nottedUploadId === action.id);
  return existing.length === 0 ? set : set.remove(existing);
}

/**
 * Re-anchor placeholders that `DecorationSet.map` reported as deleted.
 *
 * A batch selected from the file picker begins every placeholder at one
 * position. When the first of them completes, TipTap's `insertContentAt` sees
 * block-only content and *widens* the replacement to swallow the enclosing
 * textblock (`@tiptap/core` "replace an empty paragraph by an inserted image";
 * the same widening happens with the caret at the end of any paragraph). The
 * resulting step spans the shared position, so `mapResult(pos).deleted` is true
 * for the siblings and `Decoration.map` returns `null` for each of them. They
 * vanish, their `complete()` calls find no position, and a three-file batch
 * silently lands one image.
 *
 * A widget decoration is an anchor, not content: nothing about it is "inside"
 * the replaced range in the sense the mapping means. So a placeholder may only
 * leave this set through an explicit `remove` action. `map(pos, 1)` never
 * reports deletion, which gives every survivor a valid position on the far side
 * of the step.
 *
 * The rescued decoration reuses the *same* `spec.dom` node and the *same* spec
 * object, so the widget renders identically and `update` keeps mutating live
 * state rather than a copy.
 */
/**
 * Whether a transaction replaced the entire document rather than editing it.
 *
 * `TiptapEditor`'s content-sync effect calls `setContent` whenever the loaded
 * note document stops matching the editor, which dispatches a single step
 * spanning the whole document — including when the surface swaps to a different
 * note. Placeholders must *not* be rescued through that: the anchor context is
 * genuinely gone, and re-anchoring one would let an upload started in one note
 * insert its image into another. Losing them here is the pre-existing and
 * correct behaviour; the manager still calls `forget()`, so no preview leaks.
 */
function replacesWholeDocument(tr: Transaction): boolean {
  const before = tr.docs[0];
  if (before === undefined || tr.steps.length !== 1) return false;
  const size = before.content.size;
  let whole = false;
  tr.mapping.maps[0]?.forEach((oldStart, oldEnd) => {
    if (oldStart <= 0 && oldEnd >= size) whole = true;
  });
  return whole;
}

function rescueDeletedPlaceholders(
  previous: DecorationSet,
  mapped: DecorationSet,
  tr: Transaction,
): DecorationSet {
  const survivors = new Set<string>();
  for (const decoration of mapped.find()) {
    const spec = specOf(decoration);
    if (spec !== null) survivors.add(spec.nottedUploadId);
  }

  const rescued: Decoration[] = [];
  for (const decoration of previous.find()) {
    const spec = specOf(decoration);
    if (spec === null || survivors.has(spec.nottedUploadId)) continue;
    const at = Math.max(0, Math.min(tr.mapping.map(decoration.from, 1), tr.doc.content.size));
    rescued.push(Decoration.widget(at, spec.dom, decoration.spec as Record<string, unknown>));
  }

  return rescued.length === 0 ? mapped : mapped.add(tr.doc, rescued);
}

/**
 * The plugin itself: one `DecorationSet`, mapped through every transaction.
 *
 * `set.map(tr.mapping, tr.doc)` is what makes concurrent uploads correct. Every
 * character typed, every paragraph split, and every *other* upload completing
 * moves the remaining placeholders to their new positions, so an image always
 * lands where the writer put it rather than where the document happened to be
 * when the transfer started — with `rescueDeletedPlaceholders` covering the one
 * case where mapping alone loses them.
 */
export function createImageUploadPlaceholderPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: IMAGE_UPLOAD_PLACEHOLDER_KEY,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) => {
        let mapped = value.map(tr.mapping, tr.doc);
        if (tr.docChanged && !replacesWholeDocument(tr)) {
          mapped = rescueDeletedPlaceholders(value, mapped, tr);
        }
        const action: unknown = tr.getMeta(IMAGE_UPLOAD_PLACEHOLDER_KEY);
        if (action === undefined || action === null) return mapped;
        return applyAction(mapped, tr, action as PlaceholderAction);
      },
    },
    props: {
      decorations: (state) => IMAGE_UPLOAD_PLACEHOLDER_KEY.getState(state) ?? DecorationSet.empty,
    },
  });
}

/** Current document position of one placeholder, or `null` once it is gone. */
export function imageUploadPosition(state: EditorState, id: string): number | null {
  const decoration = findDecoration(state, id);
  return decoration === null ? null : decoration.from;
}

/** Every live placeholder id, in document order. Used by tests and teardown. */
export function imageUploadIds(state: EditorState): readonly string[] {
  const set = IMAGE_UPLOAD_PLACEHOLDER_KEY.getState(state);
  if (set === undefined) return [];
  return set.find().flatMap((decoration) => {
    const id = specOf(decoration)?.nottedUploadId;
    return id === undefined ? [] : [id];
  });
}

/**
 * The imperative surface the upload host drives.
 *
 * Everything ProseMirror-shaped stays behind this interface, so the React
 * adapter in `components/notes` never imports a ProseMirror module and the
 * editor never learns how to upload anything.
 */
export interface ImageInsertionController {
  /** Show a placeholder at `pos`. Adds no node and changes no document. */
  begin(id: string, pos: number, state: ImagePlaceholderState): boolean;
  /** Repaint an existing placeholder. Dispatches no transaction. */
  update(id: string, state: ImagePlaceholderState): boolean;
  /**
   * Swap a placeholder for the real image node in **one** transaction, which
   * takes exactly the route a typed character takes: `onUpdate` →
   * `safeParseNoteDocument` → `onDocumentChange` → the existing debounced PATCH.
   * No new save call site is created anywhere.
   *
   * Takes only the four attributes an upload actually determines. Part 43's
   * presentation attributes (`align`, `wrap`, `fullWidth`, `caption`) come from
   * the node schema's own defaults, which is the single place that contract is
   * stated — asking every caller to repeat them would be a second copy free to
   * drift, and the implementation below never reads them anyway.
   */
  complete(
    id: string,
    attrs: Pick<NoteDocumentImageAttrs, "attachmentId" | "alt" | "width" | "height">,
  ): boolean;
  /**
   * The generic-file counterpart of `complete` (Part 44).
   *
   * Deliberately a second method rather than a widened `complete`: the two take
   * different attribute shapes, and a union parameter would push a runtime
   * discriminator into the one code path that must not guess wrong about which
   * node type it is inserting. Everything else — the single chained transaction,
   * `updateSelection: false`, the schema guard, the placeholder removal in the
   * same step — is identical, and identical for the same reasons.
   */
  completeAttachment(id: string, attrs: NoteDocumentAttachmentAttrs): boolean;
  /** Drop a placeholder without touching the document (cancel, dismiss). */
  abandon(id: string): boolean;
  has(id: string): boolean;
  /** Live placeholder ids, so a host can tear down everything it started. */
  ids(): readonly string[];
}

export function createImageInsertionController(editor: Editor): ImageInsertionController {
  const view = (): EditorView | null => (editor.isDestroyed ? null : editor.view);

  const setState = (id: string, state: ImagePlaceholderState): boolean => {
    const current = view();
    if (current === null) return false;
    const decoration = findDecoration(current.state, id);
    const spec = decoration === null ? null : specOf(decoration);
    if (spec === null) return false;
    spec.state = state;
    paintPlaceholder(spec.dom, state);
    return true;
  };

  return {
    begin: (id, pos, state) => {
      const current = view();
      if (current === null) return false;
      const size = current.state.doc.content.size;
      const at = Math.max(0, Math.min(pos, size));
      const tr = current.state.tr.setMeta(IMAGE_UPLOAD_PLACEHOLDER_KEY, {
        type: "add",
        id,
        pos: at,
        decoration: createDecoration(id, at, state),
      } satisfies PlaceholderAction);
      // Purely a decoration change: `docChanged` is false, so TipTap emits no
      // `update` and autosave never learns this happened.
      tr.setMeta("addToHistory", false);
      current.dispatch(tr);
      return true;
    },

    update: setState,

    complete: (id, attrs) => {
      const current = view();
      if (current === null) return false;
      const pos = imageUploadPosition(current.state, id);
      if (pos === null) return false;
      if (current.state.schema.nodes.image === undefined) return false;
      // One transaction: a chain accumulates every step and dispatches once at
      // `.run()`, so the node appears and the placeholder disappears in the same
      // frame. `insertContentAt` is used rather than a raw `replaceWith` because
      // it resolves a valid block insertion point when the caret is mid-paragraph.
      return editor
        .chain()
        .insertContentAt(
          pos,
          {
            type: "image",
            attrs: {
              attachmentId: attrs.attachmentId,
              alt: attrs.alt,
              width: attrs.width,
              height: attrs.height,
            },
          },
          // The writer may have kept typing somewhere else entirely; never yank
          // their caret to the image that just finished uploading.
          { updateSelection: false },
        )
        .command(({ tr }) => {
          tr.setMeta(IMAGE_UPLOAD_PLACEHOLDER_KEY, {
            type: "remove",
            id,
          } satisfies PlaceholderAction);
          return true;
        })
        .run();
    },

    completeAttachment: (id, attrs) => {
      const current = view();
      if (current === null) return false;
      const pos = imageUploadPosition(current.state, id);
      if (pos === null) return false;
      if (current.state.schema.nodes.attachment === undefined) return false;
      return editor
        .chain()
        .insertContentAt(
          pos,
          {
            type: "attachment",
            attrs: {
              attachmentId: attrs.attachmentId,
              name: attrs.name,
              mimeType: attrs.mimeType,
              sizeBytes: attrs.sizeBytes,
            },
          },
          { updateSelection: false },
        )
        .command(({ tr }) => {
          tr.setMeta(IMAGE_UPLOAD_PLACEHOLDER_KEY, {
            type: "remove",
            id,
          } satisfies PlaceholderAction);
          return true;
        })
        .run();
    },

    abandon: (id) => {
      const current = view();
      if (current === null) return false;
      if (findDecoration(current.state, id) === null) return false;
      const tr = current.state.tr.setMeta(IMAGE_UPLOAD_PLACEHOLDER_KEY, {
        type: "remove",
        id,
      } satisfies PlaceholderAction);
      tr.setMeta("addToHistory", false);
      current.dispatch(tr);
      return true;
    },

    has: (id) => {
      const current = view();
      return current !== null && findDecoration(current.state, id) !== null;
    },

    ids: () => {
      const current = view();
      return current === null ? [] : imageUploadIds(current.state);
    },
  };
}
