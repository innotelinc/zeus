export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-ink-950">
      {/* Top bar skeleton */}
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <div className="h-7 w-24 animate-pulse rounded-lg bg-white/[0.06]" />
            <div className="hidden h-5 w-16 animate-pulse rounded-full bg-white/[0.04] sm:block" />
          </div>
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 animate-pulse rounded-lg bg-white/[0.06]" />
            <div className="hidden h-5 w-36 animate-pulse rounded bg-white/[0.04] sm:block" />
            <div className="h-8 w-8 animate-pulse rounded-lg bg-white/[0.06]" />
          </div>
        </div>
      </header>

      {/* Sidebar + Content */}
      <div className="mx-auto flex max-w-7xl gap-8 px-5 py-8 sm:px-8">
        {/* Desktop sidebar skeleton */}
        <aside className="hidden w-56 shrink-0 space-y-1 sm:block">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl px-4 py-2.5"
            >
              <div className="h-4 w-4 animate-pulse rounded bg-white/[0.06]" />
              <div
                className="h-4 animate-pulse rounded bg-white/[0.04]"
                style={{ width: `${[56, 88, 72, 64, 96, 80, 68, 84][i]}px` }}
              />
            </div>
          ))}
        </aside>

        {/* Content skeleton */}
        <main className="min-w-0 flex-1 space-y-6 pb-16">
          {/* Page heading */}
          <div className="space-y-2">
            <div className="h-7 w-48 animate-pulse rounded-lg bg-white/[0.06]" />
            <div className="h-4 w-80 animate-pulse rounded bg-white/[0.04]" />
          </div>

          {/* Content cards */}
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
              <div className="mb-4 h-4 w-32 animate-pulse rounded bg-white/[0.06]" />
              <div className="space-y-3">
                <div className="h-3 w-full animate-pulse rounded bg-white/[0.04]" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-white/[0.04]" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-white/[0.04]" />
              </div>
            </div>
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
              <div className="mb-4 h-4 w-28 animate-pulse rounded bg-white/[0.06]" />
              <div className="space-y-3">
                <div className="h-3 w-5/6 animate-pulse rounded bg-white/[0.04]" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-white/[0.04]" />
              </div>
            </div>
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 sm:col-span-2">
              <div className="mb-4 h-4 w-36 animate-pulse rounded bg-white/[0.06]" />
              <div className="space-y-3">
                <div className="h-3 w-full animate-pulse rounded bg-white/[0.04]" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-white/[0.04]" />
                <div className="h-3 w-3/5 animate-pulse rounded bg-white/[0.04]" />
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Softphone placeholder */}
      <div className="fixed bottom-4 right-4 h-12 w-48 animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02] sm:bottom-6 sm:right-6" />
    </div>
  );
}
