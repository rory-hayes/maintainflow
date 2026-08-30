import type { Metadata } from "next";
import "../../globals.css";
import localFont from "next/font/local";
import Navigation from "@/sections/navigation";
import { ConditionalClerkProvider } from "@/components/auth/conditional-clerk-provider";

export const metadata: Metadata = {
  title: "Operator access | MaintainFlow",
  description:
    "Secure operator access for reviewing and controlling OpenAI Ads recommendations.",
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
            <Navigation />
            {children}
          </ConditionalClerkProvider>
        </div>
      </body>
    </html>
  );
}
