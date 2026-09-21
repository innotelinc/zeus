import Link from "next/link";
import { SparklesIcon } from "@/components/icons";
import { ADDONS, type AddonSku, type AddonUiState } from "@/lib/addons";

interface Props {
  sku: AddonSku;
  state: AddonUiState;
  reason: string;
}

/**
 * Stands in front of a screen whose add-on is not held.
 *
 * The three states are kept distinct on purpose: "unknown" is a billing
 * lookup that could not be completed, and telling the customer their add-on
 * is off when nobody could check it would be wrong in the expensive
 * direction — they would cancel something they own.
 */
export default function AddonGate({ sku, state, reason }: Props) {
  const addon = ADDONS[sku];
  const unknown = state === "unknown";

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center">
      <SparklesIcon size={28} className="mx-auto text-brand-300" />
      <h1 className="mt-3 text-lg font-semibold text-white">{addon.label}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-white/50">{addon.description}</p>

      {unknown ? (
        <p className="mx-auto mt-4 max-w-md text-sm text-amber-300">
          We couldn&apos;t check this add-on ({reason}). Nothing has changed on your
          account — try again shortly, or contact support if it persists.
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-white/40">
            {addon.requires
              ? `Requires the ${ADDONS[addon.requires].label} add-on.`
              : "Not enabled on this account yet."}
          </p>
          <Link
            href="/dashboard/billing"
            className="mt-5 inline-block rounded-lg bg-brand-500/90 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500"
          >
            View plans
          </Link>
        </>
      )}
    </div>
  );
}
