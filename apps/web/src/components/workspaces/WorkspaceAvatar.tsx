import { cn } from "@/lib/utils";

function initialsFromName(name: string): string {
  const cleaned = name.trim();
  if (cleaned.length === 0) return "?";
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

/**
 * Workspace logo placeholder. Renders the persisted public `logoUrl` when
 * present; otherwise shows a deterministic initials block. Upload is owned by
 * Part 72, so this surface is display-only and never stores blob/preview URLs.
 */
export function WorkspaceAvatar({
  name,
  logoUrl,
  alt,
  className,
  size = "md",
}: {
  readonly name: string;
  readonly logoUrl: string | null;
  readonly alt?: string;
  readonly className?: string;
  readonly size?: "sm" | "md" | "lg";
}) {
  const sizeClasses =
    size === "lg" ? "size-16 text-xl" : size === "sm" ? "size-8 text-xs" : "size-10 text-sm";
  const label = alt ?? `${name} logo`;
  if (logoUrl !== null) {
    return (
      // Tenant branding can use an arbitrary public host, so Next Image's
      // build-time remote-host allow-list cannot represent this runtime value.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={label}
        className={cn("shrink-0 rounded-lg object-cover", sizeClasses, className)}
        loading="lazy"
      />
    );
  }
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
