import Link from "next/link";
import type { Metadata } from "next";
import localFont from "next/font/local";
import "../../globals.css";

const geistSans = localFont({
  src: "../../fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "../../fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.MAINTAINCODE_APP_ORIGIN || "https://maintainflow.io",
  ),
  title: "MaintainCode Ads | Marketing attribution",
  description:
    "Connect marketing sources to CRM enquiries, qualified leads and won deals.",
  applicationName: "MaintainCode Ads",
  category: "business",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <a
          href="#main-content"
          className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[1000000] focus:not-sr-only focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Skip to content
        </a>
        <header className="mx-auto flex max-w-6xl items-center justify-between border-b px-6 py-5">
          <Link href="/app" className="text-xl font-semibold">
            MaintainCode Ads
          </Link>
          <Link href="/app" className="text-sm underline">
            Open app
          </Link>
        </header>
        <div id="main-content" tabIndex={-1} className="min-h-screen">
          {children}
        </div>
        <footer className="mx-auto flex max-w-6xl gap-6 border-t px-6 py-6 text-sm text-muted-foreground">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </footer>
      </body>
    </html>
  );
}
