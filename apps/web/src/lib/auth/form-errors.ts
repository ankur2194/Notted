export type FieldErrors = Readonly<Record<string, string>>;

interface ValidationError {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}

export function fieldErrorsFromZod(error: ValidationError): FieldErrors {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && fields[field] === undefined) fields[field] = issue.message;
  }
  return fields;
}

export function firstFieldError(errors: FieldErrors): string | undefined {
  return Object.values(errors)[0];
}
