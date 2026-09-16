import { ChevronDown } from "lucide-react";
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

const inputClasses =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

/**
 * One box style for every native `<select>` in the app (Part 79 visual pass).
 * Before this, each caller hand-rolled its own class string and they drifted:
 * some had `border-input`, some plain `border`, some no disabled state, and
 * none hid the browser's own dropdown arrow — so the "classic" refined theme
 * sat next to a stock OS arrow on every dropdown in the app. `appearance-none`
 * removes that arrow; `Select` below draws one `ChevronDown` in its place so
 * every dropdown gets the same one, matching the app's icon set instead of
 * the OS's.
 */
const selectClasses =
  "min-h-11 w-full truncate rounded-md border border-input bg-background px-3 pr-9 text-sm text-foreground appearance-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

/**
 * The chevron is a sibling overlay, not a CSS `background-image`, because a
 * background-image arrow has to be a fixed color baked into the URL and can
 * never pick up `text-muted-foreground`'s light/dark value the way a real
 * icon element does.
 *
 * `className` lands on this wrapper, not the `<select>` itself: every
 * existing call site's className was sizing (`w-28`, `flex-1`, `w-full`,
 * `sm:max-w-xs`), which means the same thing on a block-level wrapper as it
 * did on the select. The select's own box styling is fixed by `selectClasses`
 * so it can no longer drift per call site.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return (
      <div className={cn("relative", className)}>
        <select ref={ref} className={selectClasses} {...props} />
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>
    );
  },
);

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly error?: string;
  readonly hint?: ReactNode;
}

export const FormField = forwardRef<HTMLInputElement, FieldProps>(function FormField(
  { id, label, error, hint, className, ...props },
  ref,
) {
  if (id === undefined) throw new Error("FormField requires an id");
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [
    hint === undefined ? undefined : hintId,
    error === undefined ? undefined : errorId,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      <input
        ref={ref}
        id={id}
        className={cn(inputClasses, className)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy.length === 0 ? undefined : describedBy}
        {...props}
      />
      {error === undefined ? null : (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
});

export const ErrorSummary = forwardRef<HTMLDivElement, { readonly message: string }>(
  function ErrorSummary({ message }, ref) {
    return (
      <div
        ref={ref}
        className="rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive"
        role="alert"
        tabIndex={-1}
        data-error-summary
      >
        <p className="font-medium">We could not complete this request.</p>
        <p>{message}</p>
      </div>
    );
  },
);

export function FormStatus({ children }: { readonly children: ReactNode }) {
  return (
    <p className="rounded-md bg-muted p-3 text-sm text-foreground" role="status" aria-live="polite">
      {children}
    </p>
  );
}
