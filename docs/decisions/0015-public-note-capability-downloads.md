# ADR 0015: Authorize public-note attachments with the note capability

- **Status:** Accepted
- **Date:** 2026-09-23
- **Related plan part:** 44 (public-link attachment download extension)
- **Amends:** ADR 0005's authenticated-actor requirement for this one public read; supersedes ADR 0007's expiry requirement for public *note* links only.

## Context

The existing `/p/:token` page reads one note anonymously, and its images already use a token-scoped public attachment endpoint. Generic file cards had no Download link. Sharing the authenticated attachment endpoint or making MinIO objects public would bypass note scope and revocation. The approved public-link design deliberately has revocable, non-expiring links, whereas ADR 0007 previously required expiry for hypothetical public sharing. ADR 0005 assumes every binary reader is authenticated; a recipient with only the public note link cannot satisfy that assumption.

## Decision

A valid public note token is a narrowly scoped **read capability**, not an authenticated workspace principal. Its holder may download a ready generic file or view a safe raster image only when the attachment belongs to that token's exact live note and workspace **and** a correctly typed reference remains in the note's current validated document. An orphaned or removed row does not grant access. The API looks up the hashed token, untrashed note, and exact attachment relationship together before any object-store access; invalid, revoked, wrong-note, cross-tenant, removed, unsupported, and missing resources are concealed as the same 404. This exception does not widen any authenticated endpoint, upload, mutation, note grant, export, or storage bucket policy.

Public reads stream through the API from private MinIO. Generic files always use `Content-Disposition: attachment` with the server-sanitized filename, `nosniff`, a restrictive CSP and `Cache-Control: private, no-store, max-age=0`. No conditional 304 bypasses authorization. Public-content requests use an IP-scoped bucket independent of session/API-key privileges. Capability URLs stay out of persisted TipTap JSON, logs, analytics, and generated exports. The public page and download link request `no-referrer`; deployment proxies must also redact capability path segments in access logs.

For **public note links**, the existing v1 design's explicit no-expiry choice supersedes ADR 0007's earlier hypothetical expiry rule. Revocation, regeneration, note trashing, and removal of a document reference stop new byte reads. Expiry/password policy would be a separately approved product change and migration; this extension does not introduce one. Existing exports, invitations, and other expiring grants remain governed by their own policies. A recipient's already-downloaded copy or a stream authorized before revocation cannot be recalled.

## Alternatives

- Make the bucket or a permanent object URL public: rejected because it bypasses note/document checks and revocation.
- Reuse the authenticated `file.read` endpoint or issue a synthetic workspace member: rejected because a public recipient has no workspace role and that would broaden permissions beyond this note.
- Persist a per-file signed URL in note JSON: rejected because copies, history, exports, and caches could retain the secret after revocation.
- Add expiry to every existing public note link in this attachment increment: rejected as a separate product/schema change; public-note v1 deliberately defers expiry.

## Consequences and rollback

No database migration or new dependency is needed. Public links now disclose bytes of files actually displayed in their note, so owners should share them with the same care as the note text. A per-IP request bucket does not cap total bytes/concurrent streams; operators may add proxy-level egress limits after measurement without relaxing authorization. Rolling back the feature removes the generic Download control and returns the public byte route to image-only behavior; keep the token-log redaction and no-store policy even on rollback.
