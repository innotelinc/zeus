import { getCurrentUser } from "@/lib/auth";
import { getUserDashboard } from "@/lib/dashboard";
import { fmtDate, fmtDuration } from "@/lib/client-api";
import { VoicemailIcon, PlayIcon, MailIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function VoicemailPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const dash = getUserDashboard(user.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Voicemail</h1>
        <p className="mt-1 text-sm text-white/45">
          Listen to your voicemails with transcriptions.
        </p>
      </div>

      {dash.voicemails.length === 0 ? (
        <div className="card-surface flex flex-col items-center rounded-3xl p-10 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-brand-500/15 text-brand-300">
            <VoicemailIcon size={30} />
          </div>
          <h3 className="mt-5 text-lg font-semibold text-white">No voicemails</h3>
          <p className="mt-2 max-w-md text-sm text-white/45">
            You don&apos;t have any voicemails yet. Voicemails will appear here
            when someone leaves a message on your extension.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {dash.voicemails.map((vm) => (
            <div
              key={vm.id}
              className={`card-surface rounded-2xl p-5 transition ${
                vm.listened === 0 ? "border-brand-500/30" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4 min-w-0">
                  <div className={`shrink-0 mt-1 flex h-10 w-10 items-center justify-center rounded-full ${
                    vm.listened === 0 ? "bg-brand-500/15" : "bg-white/[0.05]"
                  }`}>
                    <VoicemailIcon size={18} className={vm.listened === 0 ? "text-brand-300" : "text-white/35"} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-white truncate">
                        {vm.caller_name ?? vm.caller_id ?? "Unknown caller"}
                      </h3>
                      {vm.listened === 0 && (
                        <span className="shrink-0 rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                          New
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-white/35 mt-0.5">
                      {vm.caller_id && <span>{vm.caller_id} · </span>}
                      {fmtDuration(vm.duration_seconds)} · {fmtDate(vm.created_at)}
                    </p>
                    {vm.transcript && (
                      <p className="mt-2 text-sm text-white/65 line-clamp-2 italic">
                        &ldquo;{vm.transcript}&rdquo;
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/50 transition hover:text-white"
                    title="Play"
                  >
                    <PlayIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-2 text-white/50 transition hover:text-white"
                    title="Email"
                  >
                    <MailIcon size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
