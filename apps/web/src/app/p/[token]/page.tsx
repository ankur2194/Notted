import { ATTACHMENT_API_PATHS } from "@notted/shared-types";
import { renderPublicDocumentHtml } from "@notted/shared-validators";
import { printStylesheet } from "@notted/shared-validators/server";
import { notFound } from "next/navigation";

import type { Metadata } from "next";

import { primaryApiOrigin } from "@/lib/api/api-origin";
import { getPublicNote } from "@/lib/notes/server-public-note";

// A capability URL is only meant for whoever holds the link — the root
// layout's `robots: "index, follow"` default would let a crawler that
// stumbles onto one (pasted into a forum, a ticket, telemetry) permanently
// index the note's full text. Opt this route out explicitly.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * `/p/:token` — the unauthenticated, read-only public note view. Sits as a
 * sibling of the `(auth)`/`(dashboard)` route groups, so it inherits only the
 * root layout (`apps/web/src/app/layout.tsx`) and never the dashboard shell's
 * sidebar/header (`apps/web/src/app/(dashboard)/layout.tsx`), which also
 * requires an authenticated session this visitor by definition doesn't have.
 */
export default async function PublicNotePage({
  params,
}: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await params;
  const result = await getPublicNote(token);
  if (result.status === "not-found") notFound();
  if (result.status === "unavailable") {
    return (
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl p-8" role="alert">
        <h1 className="text-2xl font-bold">This note is unavailable</h1>
        <p className="mt-2 text-muted-foreground">
          The note could not be loaded safely. No content was rendered.
        </p>
      </main>
    );
  }
  const { title, content } = result.data;
  const resolveImageSrc = (attachmentId: string): string =>
    new URL(ATTACHMENT_API_PATHS.publicContent(token, attachmentId), primaryApiOrigin()).toString();
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl p-8">
      {/*
        `printStylesheet()` is almost entirely `@media print` rules, same as
        the HTML export path — see `buildStandaloneHtml`. It's included here
        purely so print/export of this page matches the editor's own output.
        On-screen, this page reuses `.notted-editor-content`'s typography
        (headings, tables, code, images, attachments) from `globals.css` —
        `renderPublicDocumentHtml`'s markup is deliberately the same contract
        `.notted-editor-content`'s image/attachment selectors already key off
        (see the comment above those rules), so no new CSS is needed here.
        One override: the live editor fades an image in via `[data-image-
        loaded="true"]`, a client-side attribute this static page never sets,
        so it is forced visible instead.
      */}
      <style dangerouslySetInnerHTML={{ __html: printStylesheet() }} />
      <style>{".notted-public-note .notted-image { opacity: 1; }"}</style>
      <h1 className="text-3xl font-bold">{title}</h1>
      <div
        className="notted-editor-content notted-public-note mt-6"
        // `renderPublicDocumentHtml` is `renderDocumentHtml` — the same
        // defensive TipTap-JSON-to-HTML converter the HTML/PDF export path
        // uses on the exact same untrusted persisted content, never emitting
        // `href`-bearing markup outside its own sanitized allowlist — with a
        // real, token-scoped `src` wired onto each image, `data-mention-id`
        // stripped, and a generic file attachment's `data-attachment-id`
        // stripped too (it has no public content route to point at).
        dangerouslySetInnerHTML={{ __html: renderPublicDocumentHtml(content, resolveImageSrc) }}
      />
    </main>
  );
}
