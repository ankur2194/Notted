import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils";

const inputClasses =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

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
