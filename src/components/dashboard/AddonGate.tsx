import Link from "next/link";
import { SparklesIcon } from "@/components/icons";
import { ADDONS, type AddonSku, type AddonUiState } from "@/lib/addons";

interface Props {
  sku: AddonSku;
  state: AddonUiState;
  reason: string;
  /**
   * Why the screen is closed, when it is not the billing answer `unknown`
   * describes.
   *
   * `"deployment"` means this box has no voice engine wired to it at all. That
   * used to be rendered through the `unknown` copy — "Nothing has changed on
   * your account — try again shortly, or contact support" — which is wrong for
   * it: a missing deployment credential is not transient and no amount of
   * retrying or support changes it. Only an administrator can, so only the
   * deployment wording is offered.
   */
  mode?: "billing" | "deployment";
}

/**
 * Stands in front of a screen whose add-on is not held.
 *
 * The three states are kept distinct on purpose: "unknown" is a billing
 * lookup that could not be completed, and telling the customer their add-on
 * is off when nobody could check it would be wrong in the expensive
 * direction — they would cancel something they own.
 *
 * A config state is a fourth case, and it is not a billing one — see `mode`.
 */
export default function AddonGate({ sku, state, reason, mode = "billing" }: Props) {
  const addon = ADDONS[sku];
  const unknown = state === "unknown";

  if (mode === "deployment") {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-8 text-center">
        <SparklesIcon size={28} className="mx-auto text-brand-300" />
        <h1 className="mt-3 text-lg font-semibold text-white">{addon.label}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-white/50">{addon.description}</p>
        <p className="mx-auto mt-4 max-w-md text-sm text-amber-300">
          No voice engine is connected to this portal yet, so there is nothing to show here.
          This is a setup step on the deployment, not a change to your account — an
          administrator enables it.
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs text-white/35">{reason}</p>
      </div>
    );
  }

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
