"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import type { ReactNode } from "react";

import { apiAssetUrl, primaryApiOrigin } from "@/lib/api/api-origin";
import { cn } from "@/lib/utils";

// The logo origin is a runtime value in the browser (Part 73 custom hosts) but a
// build-time one on the server; `useSyncExternalStore` hydrates with the server
// answer and re-renders with the browser's, instead of tripping a mismatch.
const subscribeNever = () => () => {};

function initialsFromName(name: string): string {
  const cleaned = name.trim();
  if (cleaned.length === 0) return "?";
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

/**
 * Workspace logo. Renders the persisted `logoUrl` when present, and falls back
 * to a deterministic initials block (or a caller-supplied node) otherwise.
 *
 * A CLIENT component since Part 72, for one reason: `onError`. A logo can break
 * after it was persisted — object storage disabled, the object swept, a slow
 * network — and `Plan.md`'s verification for this part is explicitly that
 * *broken assets fall back to Notted branding*. That is a runtime event, so the
 * component that has to notice it cannot be server-only.
 *
 * `logoUrl` is the APP-RELATIVE path the API persisted; `apiAssetUrl` resolves
 * it and refuses anything that is not app-relative, so a malformed or hostile
 * stored value renders the fallback rather than pointing an `<img>` elsewhere.
 * A blob or preview URL is never accepted here — the caller uploads first and
 * re-renders from the persisted path (frontend standard).
 */
export function WorkspaceAvatar({
  name,
  logoUrl,
  alt,
  className,
  size = "md",
  fallback,
}: {
  readonly name: string;
  readonly logoUrl: string | null;
  readonly alt?: string;
  readonly className?: string;
  readonly size?: "sm" | "md" | "lg";
  /** Rendered instead of the initials block when there is no usable logo. */
  readonly fallback?: ReactNode;
}) {
  const resolved = useSyncExternalStore(
    subscribeNever,
    () => apiAssetUrl(logoUrl),
    () => apiAssetUrl(logoUrl, primaryApiOrigin()),
  );
  const [broken, setBroken] = useState(false);

  // A new workspace (or a freshly uploaded logo) must get a fresh attempt;
  // otherwise one broken image would suppress every later one.
  useEffect(() => {
    setBroken(false);
  }, [resolved]);

  const sizeClasses =
    size === "lg" ? "size-16 text-xl" : size === "sm" ? "size-8 text-xs" : "size-10 text-sm";
  const label = alt ?? `${name} logo`;

  if (resolved !== null && !broken) {
    return (
      // Tenant branding is served from the API origin, which is a runtime value;
      // Next Image's build-time remote-host allow-list cannot represent it.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resolved}
        alt={label}
        className={cn("shrink-0 rounded-lg object-cover", sizeClasses, className)}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }

  if (fallback !== undefined) return <>{fallback}</>;

  return (
    <span
      role="img"
      aria-label={`${label} placeholder`}
      className={cn(
        "grid shrink-0 place-items-center rounded-lg bg-primary font-semibold text-primary-foreground",
        sizeClasses,
        className,
      )}
    >
      {initialsFromName(name)}
    </span>
  );
}
