import { ChevronRight, Home } from "lucide-react";
import Link from "next/link";

export interface BreadcrumbItem {
  readonly label: string;
  readonly href?: string;
}

export function Breadcrumb({ items }: { readonly items: readonly BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        <li>
          <Link
            href="/"
            aria-label="Dashboard"
            className="flex min-h-10 min-w-10 items-center justify-center rounded-md hover:text-foreground"
          >
            <Home aria-hidden="true" className="size-4" />
          </Link>
        </li>
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
            <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
            {item.href === undefined ? (
              <span aria-current="page" className="truncate font-medium text-foreground">
                {item.label}
              </span>
            ) : (
              <Link
                href={item.href}
                className="truncate rounded-sm hover:text-foreground hover:underline"
              >
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
