import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SubscribeLanding } from "@/components/SubscribeLanding";
import { subscribeOrigin } from "@/lib/catalog";

const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME ?? "Zeus";

export const metadata: Metadata = {
  title: `Subscribe to ${BRAND_NAME} — Voice, SMS, fax and AI voice agents`,
  description:
    "Pick your Zeus plan, get your phone number, and start calling in minutes. AI voice agents are available as an add-on.",
};

/**
 * The subscription page.
 *
 * Its one canonical home is `subscribe.<domain>`, served as `/` by this same
 * deployment (see app/page.tsx). A `/subscribe` request on any other host of
 * that domain redirects there, so links, bookmarks and search results all
 * converge on one URL instead of two doors into the same page.
 */
export default async function SubscribePage() {
  const host = (await headers()).get("host") ?? "";
  if (!host.toLowerCase().startsWith("subscribe.")) {
    redirect(subscribeOrigin(host));
  }
  return <SubscribeLanding />;
}
