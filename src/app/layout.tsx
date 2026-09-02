import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import PwaRegister from "@/components/PwaRegister";

// Render all routes on demand. Statically prerendering pages that consume
// next/navigation crashes in some environments due to a Next.js framework bug
// (null React hook dispatcher), so this portal is fully dynamic.
export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME ?? "Zeus";
const PUBLIC_URL = (process.env.NEXT_PUBLIC_URL ?? "https://app.zeus.innotel.us").replace(/\/+$/, "");

export const metadata: Metadata = {
  title: `${BRAND_NAME} VOIP — Business VoIP & Unified Communications`,
  description:
    "Zeus provides business VoIP, SIP, SMS, and fax services. Get phone numbers, extensions, and unified messaging for your business or personal use.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icons/zeus-icon.svg",
    apple: "/icons/zeus-icon.svg",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: BRAND_NAME,
  },
  openGraph: {
    title: `${BRAND_NAME} VOIP Platform`,
    description:
      "Cloud-native VoIP platform — phone numbers, SIP routing, SMS, fax, voicemail, and billing.",
    url: PUBLIC_URL,
    siteName: BRAND_NAME,
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a12",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}