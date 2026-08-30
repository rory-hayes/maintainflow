import Navigation from "@/sections/navigation";
import type { Metadata } from "next";
import localFont from "next/font/local";
import "../../globals.css";
import Footer from "@/sections/footer";
import Cta from "@/sections/cta";

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
  title: "MaintainFlow | Control your OpenAI Ads with confidence",
  description:
    "Evidence-backed recommendations, human approvals, and guarded OpenAI Ads changes.",
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
        <Navigation />
        <div className="min-h-screen">{children}</div>
        <Cta />
        <Footer />
      </body>
    </html>
  );
}
