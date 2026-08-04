import { APP_NAME } from "@notted/shared-types";

import type { Metadata, Viewport } from "next";

import "@/styles/globals.css";
import { ToasterProvider } from "@/components/ui/toaster-provider";

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s | ${APP_NAME}`,
  },
  description: "Corporate notes management platform",
  keywords: ["notes", "productivity", "team", "collaboration", "workspace"],
  authors: [{ name: "Notted" }],
  creator: "Notted",
  publisher: "Notted",
  robots: "index, follow",
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: APP_NAME,
    title: APP_NAME,
    description: "Corporate notes management platform",
  },
  twitter: {
    card: "summary_large_image",
    title: APP_NAME,
    description: "Corporate notes management platform",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth" data-scroll-behavior="smooth">
      {/*
        Extensions such as Grammarly and ColorZilla add attributes to <body>
        (`data-gr-ext-installed`, `cz-shortcut-listen`, …) before React
        hydrates, which React reports as an attribute mismatch the server can
        never match. This suppresses that comparison for this element's own
        attributes only; children are still checked normally, so a real
        mismatch in the application tree is still reported.
      */}
      <body className="min-h-screen bg-background font-sans antialiased" suppressHydrationWarning>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground"
        >
          Skip to main content
        </a>
        {children}
        <ToasterProvider />
      </body>
    </html>
  );
}
