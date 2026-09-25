import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDashboardUser } from "@/lib/dashboard-auth";
import { CONSOLE_PRODUCTS, CONSOLE_SURFACES, proxiedLaunchers } from "@/lib/console";
import { HeartPulseIcon, CogIcon } from "@/components/icons";
import { SERVICE_KEYS } from "@/lib/health-services";
import { Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { ServiceStatus } from "@/components/dashboard/ServiceStatus";

export const dynamic = "force-dynamic";

export const metadata = { title: "Operations — Zeus" };

/**
 * Optional monitoring tools, read from the environment.
 *
 * These stay optional because a deployment may run the bundled observability
 * profile, point at Capstone's SigNoz, or run neither — and a link to a tool
 * that is not there is worse than no link.
 */
const MONITORING_TOOLS: Array<{ env: string; label: string; answers: string }> = [
  { env: "SIGNOZ_URL", label: "SigNoz", answers: "Traces, logs and metrics across the estate" },
  { env: "GRAFANA_URL", label: "Grafana", answers: "Dashboards over the estate's metrics" },
  { env: "PROMETHEUS_URL", label: "Prometheus", answers: "The raw metric store" },
];

/**
 * Operations — the estate's machine room.
 *
 * This is the portal's half of what the Capstone control panel calls *Services*
 * and *Links*. The console's rule is one author per fact: what a screen can own
 * it does, and what depends on another product's stack is a labelled link.
 *
 *   * **Owned** — the service probes (`/api/health`, through the shared
 *     `lib/health-services.ts`), and the resource directory built from the same
 *     registry the rail renders.
 *   * **Linked** — the control panel's deep pages (Services detail, Monitoring,
 *     Logs, Secrets). They read the Docker socket and the host's `.env`, which
 *     belong on the box that owns them and must not be widened into the customer
 *     portal.
 *
 * Staff-only, because that is who the linked pages are for.
 */
export default async function OperationsPage() {
  const user = await requireDashboardUser();
  if (user.role !== "admin") notFound();

  // Every proxied surface, resolved and labelled, grouped by the product it
  // opens — the same registry the rail and the System Map render from.
  const launchers = proxiedLaunchers(
    CONSOLE_PRODUCTS.map((product) => product.id).filter((id) => id !== "asterisk" && id !== "zeus"),
  );
  const byProduct = launchers.reduce<Record<string, typeof launchers>>((acc, launcher) => {
    (acc[launcher.productName] ??= []).push(launcher);
    return acc;
  }, {});

  const controlPanel = launchers.find((l) => l.id === "capstone-dashboard")?.href ?? null;
  const tools = MONITORING_TOOLS.map((tool) => ({
    ...tool,
    href: (process.env[tool.env] ?? "").trim().replace(/\/+$/, ""),
  })).filter((tool) => tool.href);

  const ownedRoutes = CONSOLE_SURFACES.filter(
    (surface) => surface.kind === "owned" && !surface.adminOnly,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operations"
        icon={<CogIcon size={20} className="text-brand-300" />}
        description="The estate's services, the tools that watch it, and a labelled door into every product it runs on."
        actions={
          <Link href="/dashboard/health" className="text-xs text-brand-300 hover:text-brand-200">
            Detailed health →
          </Link>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Services probed"
          value={SERVICE_KEYS.length}
          hint="on the Health endpoint"
          icon={<HeartPulseIcon size={13} />}
        />
        <Stat label="Linked products" value={launchers.length ? Object.keys(byProduct).length : 0} hint="proxied surfaces" />
        <Stat
          label="Monitoring tools"
          value={tools.length}
          hint={tools.length ? tools.map((t) => t.label).join(", ") : "none configured"}
        />
      </div>

      {/* ── Services (owned) ──────────────────────────────────── */}
      <ServiceStatus />

      {/* ── Deep operations (linked) ──────────────────────────── */}
      <Card>
        <CardHeader
          title="Look further"
          answers="The control panel's deep pages read the Docker socket and the host's .env — they stay on the box that owns them, and are linked, not copied."
          icon={<CogIcon size={14} />}
        />
        {controlPanel ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { path: "/services", label: "Services", answers: "Containers, ports and live stats" },
              { path: "/monitoring", label: "Monitoring", answers: "Host and service resource history" },
              { path: "/logs", label: "Logs", answers: "Per-service log tails" },
              { path: "/secrets", label: "Secrets", answers: "The deployment's .env inventory" },
            ].map((page) => (
              <a
                key={page.path}
                href={`${controlPanel}${page.path}`}
                target="_blank"
                rel="noreferrer"
                className="group rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition hover:border-brand-500/30 hover:bg-white/[0.04]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white">{page.label}</span>
                  <span className="text-xs text-white/25 transition group-hover:text-brand-300">↗</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">{page.answers}</p>
                <p className="mt-2 text-[10px] uppercase tracking-wide text-white/25">
                  opens Capstone dashboard
                </p>
              </a>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No control panel is configured"
            description="Set CAPSTONE_DASHBOARD_URL to link the estate's deep operations pages."
          />
        )}

        {tools.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-3 border-t border-white/[0.05] pt-4">
            {tools.map((tool) => (
              <a
                key={tool.env}
                href={tool.href}
                target="_blank"
                rel="noreferrer"
                title={`${tool.answers} — opens ${tool.label}`}
                className="text-xs text-brand-300 hover:text-brand-200"
              >
                {tool.label} ↗
              </a>
            ))}
          </div>
        ) : null}
      </Card>

      {/* ── Resource directory (owned, from the registry) ─────── */}
      <Card>
        <CardHeader
          title="Every product, one door"
          answers="Built from the same registry the rail renders, so a linked product cannot exist in one and not the other."
        />
        {Object.keys(byProduct).length === 0 ? (
          <EmptyState
            title="No products are linked"
            description="A deployment can point these at FreePBX, AvantFax, Dograh, Workflow Studio and the Capstone dashboard."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(byProduct).map(([product, items]) => (
              <div key={product}>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/30">
                  {product}
                </div>
                <ul className="space-y-1.5">
                  {items.map((launcher) => (
                    <li key={launcher.id}>
                      <a
                        href={launcher.href}
                        target="_blank"
                        rel="noreferrer"
                        title={launcher.answers}
                        className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-3 py-2 text-sm text-white/70 transition hover:border-brand-500/30 hover:text-white"
                      >
                        <span className="truncate">{launcher.label}</span>
                        <span className="shrink-0 text-xs text-white/25">↗</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-3 border-t border-white/[0.05] pt-4 text-xs">
          {ownedRoutes.map((surface) => (
            <Link
              key={surface.id}
              href={surface.href ?? "/dashboard"}
              className="text-brand-300 hover:text-brand-200"
            >
              {surface.label} →
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
