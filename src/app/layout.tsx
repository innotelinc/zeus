import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

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

export const metadata: Metadata = {
  title: "Innotel Voice — Business VoIP & Unified Communications",
  description:
    "Innotel provides business VoIP, SMS, and fax services. Get phone numbers, extensions, and unified messaging for your business or personal use.",
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
      </body>
    </html>
  );
}
