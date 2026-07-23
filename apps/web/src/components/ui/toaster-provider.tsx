"use client";

import { Toaster as SonnerToaster } from "sonner";

export function ToasterProvider() {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "group bg-background text-foreground border-border shadow-lg",
          description: "text-muted-foreground",
          actionButton: "bg-primary text-primary-foreground hover:bg-primary/90",
          cancelButton: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        },
      }}
      theme="light"
    />
  );
}
