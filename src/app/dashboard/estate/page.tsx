import Link from "next/link";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { PageHeader } from "@/components/ui";
import { addonStatuses } from "@/lib/addons";
import {
  CONSOLE_PRODUCTS,
  CONSOLE_GROUPS,
  groupedSurfaces,
  proxiedHost,
  proxiedUrl,
  type ConsoleSurface,
} from "@/lib/console";

export const dynamic = "force-dynamic";

export const metadata = { title: "System Map — Zeus" };

/**
 * Where a fact lives.
 *
 * This table is the answer to the question that produced this page: an
 * operator doing one job had to know which of five products held the answer.
 * Each row names one fact and the single product that authors it — which is
 * the whole reason the estate is navigable at all.
 */
const FACT_OWNERS: Array<{ fact: string; author: string; read: string }> = [
  {
    fact: "Which number belongs to which account",
    author: "Zeus portal",
    read: "Portal, the PBX route writer",
  },
  {
    fact: "Which agent or workflow a number reaches",
    author: "Zeus portal",
    read: "The dialplan, Dograh",
  },
  {
    fact: "An agent's prompt, tools, voice and turn-taking",
    author: "Dograh",
    read: "Portal (read-only)", 
  },
  {
    fact: "Trunks, outbound routes, Module Admin",
    author: "FreePBX",
    read: "Portal (read-only)",
  },
  {
    fact: "The per-call envelope (call id, context token)",
    author: "The dialplan, at ingress",
    read: "Dograh, the portal's context read",
  },
  {
    fact: "The transcript, the recording, how a call ended",
    author: "Dograh",
    read: "Portal",
  },
  { fact: "Fax in and out", author: "AvantFax", read: "Portal (webhook and read)" },
];

function SurfaceRow({ surface }: { surface: ConsoleSurface }) {
  const external = proxiedUrl(surface);
  const host = proxiedHost(surface);

  return (
    <li className="flex items-start gap-4 border-b border-white/[0.04] py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {surface.kind === "owned" && surface.href ? (
            <Link
              href={surface.href}
              className="font-medium text-white transition hover:text-brand-300"
            >
              {surface.label}
            </Link>
          ) : (
            <span className="font-medium text-white/80">{surface.label}</span>
          )}
          {surface.kind === "proxied" ? (
            <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] text-white/35">
              opens {host ?? surface.product}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-white/40">{surface.answers}</p>
      </div>
      {external ? (
        <a
          href={external}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 self-center text-xs text-brand-300/70 transition hover:text-brand-200"
        >
          Open ↗
        </a>
      ) : null}
    </li>
  );
}

/**
 * The console's map — what the estate is made of.
 *
 * It exists because the nav alone cannot answer "who owns this fact?" for
 * someone who has just arrived: the rail says where to go, this page says why
 * the estate is shaped that way. It is rendered from the same registry the nav
 * is (`lib/console.ts`), so it cannot drift from it.
 */
export default async function EstatePage() {
  const user = await requireDashboardUser();
  const statuses = await addonStatuses({ user: user.email });
  const addons = Object.fromEntries(statuses.map((s) => [s.sku, s.state]));

  const groups = groupedSurfaces({ isAdmin: user.role === "admin", addons });
  const surfaceCount = groups.reduce((total, group) => total + group.surfaces.length, 0);
  const owned = groups.reduce(
    (total, group) => total + group.surfaces.filter((s) => s.kind === "owned").length,
    0,
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="System map"
        description={`One console for six products. ${owned} of ${surfaceCount} screens are built here; the rest are labelled links into the product that owns them, because rewriting FreePBX or AvantFax would cost years and change nothing an operator does.`}
      />

      {/* The products */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white">What this estate is made of</h2>
        <p className="mt-1 text-sm text-white/45">
          Asterisk answers the call. Everything above it is convenience — and this portal is the
          frame all of it sits in.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CONSOLE_PRODUCTS.map((product) => (
            <div
              key={product.id}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-white">{product.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] ${
                    product.relationship === "owns"
                      ? "border border-brand-500/25 bg-brand-500/10 text-brand-300"
                      : "border border-white/[0.08] bg-white/[0.03] text-white/35"
                  }`}
                >
                  {product.relationship === "owns"
                    ? "built here"
                    : product.relationship === "proxies"
                      ? "linked out"
                      : "read here"}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-white/45">{product.role}</p>
              <p className="mt-2 font-mono text-[10px] text-white/25">{product.stack}</p>
            </div>
          ))}
        </div>
      </section>

      {/* The screens, by question */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white">Every screen, grouped by question</h2>
        <p className="mt-1 text-sm text-white/45">
          This is the rail, spelled out. A group is a question an operator asks — never a product
          they have to remember.
        </p>
        <div className="mt-5 space-y-6">
          {CONSOLE_GROUPS.map((group) => {
            const present = groups.find((g) => g.id === group.id);
            if (!present) return null;
            return (
              <div key={group.id}>
                <div className="flex items-baseline gap-3">
                  <h3 className="text-sm font-semibold text-white">{group.label}</h3>
                  <span className="text-xs text-white/30">{group.answers}</span>
                </div>
                <ul className="mt-2">
                  {present.surfaces.map((surface) => (
                    <SurfaceRow key={surface.id} surface={surface} />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* One author per fact */}
      <section className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
        <h2 className="text-lg font-semibold text-white">Every fact has one author</h2>
        <p className="mt-1 max-w-3xl text-sm text-white/45">
          Two products writing the same fact is how this estate became five UIs with no shared
          navigation. Each row below is authored in exactly one place; everything else reads.
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] text-xs text-white/40">
                <th className="px-3 pb-3 font-medium">Fact</th>
                <th className="px-3 pb-3 font-medium">Authored in</th>
                <th className="px-3 pb-3 font-medium">Read by</th>
              </tr>
            </thead>
            <tbody>
              {FACT_OWNERS.map((row) => (
                <tr key={row.fact} className="border-b border-white/[0.04] last:border-0">
                  <td className="px-3 py-3 text-white/80">{row.fact}</td>
                  <td className="px-3 py-3">
                    <span className="rounded-lg border border-brand-500/20 bg-brand-500/[0.06] px-2 py-0.5 text-xs text-brand-300">
                      {row.author}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-white/40">{row.read}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
