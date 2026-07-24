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
    <html lang="en" className="scroll-smooth">
      <body className="min-h-screen bg-background font-sans antialiased">
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
