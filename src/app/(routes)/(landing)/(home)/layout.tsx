import type { Metadata } from "next";

const title = "MaintainCode Ads | Marketing attribution";
const description =
  "Connect marketing sources to CRM enquiries, qualified leads and won deals.";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "MaintainCode Ads",
    title,
    description,
  },
  twitter: {
    card: "summary",
    title,
    description,
  },
};

export default function HomeLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
