import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ConditionalClerkProvider } from "@/components/auth/conditional-clerk-provider";
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
  title: "MaintainFlow · Ads review",
  description:
    "Evidence-backed recommendations and guarded changes for OpenAI Ads.",
  robots: { index: false, follow: false },
};

export default function ProductLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ConditionalClerkProvider>
          <TooltipProvider delayDuration={250}>{children}</TooltipProvider>
          <Toaster position="bottom-right" richColors />
        </ConditionalClerkProvider>
      </body>
    </html>
  );
}
