# ADR 0016: Preserve generic attachment bytes and original extensions

- **Status:** Accepted
- **Date:** 2026-10-01
- **Related plan parts:** 40, 44, 45
- **Supersedes:** ADR 0005's MIME sniffing and canonical extension requirements for generic attachments only

## Context

The user requires generic attachments to be stored and downloaded with their original extensions and without content/type checks. The prior Office detector searched only the first 256 bytes of ZIP packages for `[Content_Types].xml`, so valid DOCX/XLSX files could become `.zip`. The earlier format allow-list also rejected otherwise valid opaque attachments.

## Decision

Generic `uploadFile` accepts any nonempty byte buffer within configured size and workspace quota limits. It does not sniff signatures, scan text, decode images, examine archives, apply format allow-lists, or select extensions from MIME. It writes the original buffer unchanged.

The upload endpoint accepts optional multipart `kind=file|image`. Missing `kind` means `file`; explicit `image` retains the existing image validation, processing, rasterization and canonical rendition naming. Callers inserting editor images must now send `kind=image`. The first-party client sends kind explicitly for both actions. Image bytes attached through the generic action remain generic downloadable files.

Filename sanitation retains traversal, control/bidi, device-name, platform-illegal-character and 255-byte protections. The sanitized original filename, including extension case and compound suffixes, drives both metadata and download disposition. Opaque original object keys retain the sanitized original suffix; extensionless files have no suffix. The key builder and cleanup parser share a bounded structural suffix grammar, not a file-format allow-list. Existing keys remain readable and parsable.

Declared MIME is descriptive metadata only. A bounded MIME grammar prevents unsafe response headers and invalid document contracts; invalid/missing MIME falls back to `application/octet-stream` without refusing the file. All generic authenticated/public downloads use `application/octet-stream`, forced attachment disposition, `nosniff` and sandbox CSP. This keeps untrusted descriptive MIME from affecting a browser’s saved extension. Image inline rendering still permits only safe raster renditions. Authorization, exact tenant/note and current public-document reference checks, private storage, idempotency, quota, limits, compensation and cleanup remain in place.

## Alternatives considered

- Increase the ZIP scan window: rejected because valid packages may place entries anywhere, and the user requires no generic content/type checks.
- Parse ZIP directories: rejected for this scope because it still introduces format detection and extension rewriting.
- Serve generic attachments inline based on their declared MIME: rejected because MIME is untrusted descriptive metadata.

## Consequences

Any file format, mismatched MIME/extension and opaque binary can be attached and downloaded unchanged. Consumers decide how to open downloaded files. There is no content or malware validation guarantee for generic attachments. The explicit image kind is a routing contract change for external image-upload callers.

## Migration and rollback impact

No database migration or object move is performed. New generic uploads store equal `filename` and `originalName`. Reads/listing prefer a freshly sanitized legacy `originalName` when available, repairing old download/display extensions without moving stored objects or rewriting note JSON. Old storage keys and metadata remain available. ZIP exports preserve the supplied attachment filename rather than lowercasing or truncating its suffix. Rollback can read the widened keys; deploying the old cleanup parser would conservatively skip unfamiliar suffixes, so keep the new parser during rollback until retained objects are accounted for.

Legacy note JSON or exported bundles may still carry old cached labels; this change does not destructively backfill them. The authoritative authenticated/public download filename comes from attachment metadata.
