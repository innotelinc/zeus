import { getCurrentUser } from "@/lib/auth";
import { CogIcon, CheckCircleIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Settings</h1>
        <p className="mt-1 text-sm text-white/45">Manage your account settings.</p>
      </div>

      {/* Profile */}
      <div className="card-surface rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">Profile</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="input-label">Name</span>
            <input className="input-base" defaultValue={user.name} />
          </label>
          <label className="block">
            <span className="input-label">Email</span>
            <input className="input-base" type="email" defaultValue={user.email} />
          </label>
          <label className="block">
            <span className="input-label">Phone</span>
            <input className="input-base" type="tel" defaultValue={user.phone ?? ""} placeholder="+1 555 123 4567" />
          </label>
          <label className="block">
            <span className="input-label">Country</span>
            <input className="input-base" defaultValue={user.country} />
          </label>
        </div>
        <button type="button" className="btn-primary px-6 py-2.5 text-sm">
          Save changes
        </button>
      </div>

      {/* Password */}
      <div className="card-surface rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">Change Password</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="input-label">Current password</span>
            <input className="input-base" type="password" />
          </label>
          <label className="block">
            <span className="input-label">New password</span>
            <input className="input-base" type="password" />
          </label>
          <label className="block">
            <span className="input-label">Confirm new password</span>
            <input className="input-base" type="password" />
          </label>
        </div>
        <button type="button" className="btn-ghost px-6 py-2.5 text-sm">
          Update password
        </button>
      </div>

      {/* Plan info */}
      <div className="card-surface rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white">Plan</h2>
        <div className="mt-3 flex items-center gap-6">
          <div className="flex items-center gap-2">
            <CheckCircleIcon size={18} className="text-mint-400" />
            <span className="text-white font-medium capitalize">{user.plan} Plan</span>
          </div>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            user.plan_status === "active" ? "bg-mint-500/10 text-mint-400" : "bg-sun-400/10 text-sun-400"
          }`}>
            {user.plan_status}
          </span>
        </div>
        {user.plan === "consumer" && (
          <p className="mt-4 text-sm text-white/45">
            Need more numbers and features?{" "}
            <button type="button" className="font-medium text-brand-300 hover:text-brand-200">
              Upgrade to Business
            </button>
          </p>
        )}
      </div>

      {/* API & integrations */}
      <div className="card-surface rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white">API & Integrations</h2>
        <p className="mt-1 text-sm text-white/45">
          External integrations and API access for advanced users.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2">
              <CheckCircleIcon size={14} className="text-mint-400" />
              <span className="text-sm font-medium text-white">VoIP.ms</span>
            </div>
            <p className="mt-1 text-xs text-white/35">Provider connection active</p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2">
              <CheckCircleIcon size={14} className="text-mint-400" />
              <span className="text-sm font-medium text-white">FreePBX</span>
            </div>
            <p className="mt-1 text-xs text-white/35">PBX connection active</p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2">
              <CheckCircleIcon size={14} className="text-mint-400" />
              <span className="text-sm font-medium text-white">AvantFax</span>
            </div>
            <p className="mt-1 text-xs text-white/35">Fax service active</p>
          </div>
        </div>
      </div>
    </div>
  );
}
