import type { Metadata } from "next";
import "../../globals.css";
import localFont from "next/font/local";

import { ConditionalClerkProvider } from "@/components/auth/conditional-clerk-provider";

export const metadata: Metadata = {
  title: "Workspace access | MaintainCode Ads",
  description: "Secure access to your attribution workspace.",
  robots: { index: false, follow: false },
};

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <div className=" h-screen">
          <ConditionalClerkProvider>
            <header className="border-b p-6">
              <a href="/app" className="font-semibold">
                MaintainCode Ads
              </a>
            </header>
            {children}
          </ConditionalClerkProvider>
        </div>
      </body>
    </html>
  );
}
