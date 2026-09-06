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
  metadataBase: new URL(
    process.env.MAINTAINCODE_APP_ORIGIN || "https://maintainflow.io",
  ),
  applicationName: "MaintainCode Ads",
  title: "MaintainCode Ads · Attribution",
  description:
    "See which marketing channels become qualified leads and won customers.",
  robots: { index: false, follow: false },
};

export default function ProductLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ConditionalClerkProvider>
          <TooltipProvider delayDuration={250}>{children}</TooltipProvider>
          <Toaster position="bottom-right" richColors />
        </ConditionalClerkProvider>
      </body>
    </html>
  );
}
