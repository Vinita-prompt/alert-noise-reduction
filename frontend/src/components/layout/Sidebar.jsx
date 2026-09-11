import {
  Activity,
  Bell,
  Cable,
  Gauge,
  GitBranch,
  MonitorCheck,
  PlugZap,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';

const navItems = [
  { label: 'Dashboard', path: '/dashboard', icon: Gauge },
  { label: 'Integrations', path: '/integrations', icon: PlugZap },
  { label: 'Monitoring', path: '/monitoring', icon: MonitorCheck },
  { label: 'Sources', path: '/sources', icon: Cable },
  { label: 'Alerts', path: '/alerts', icon: Bell },
  { label: 'Incidents', path: '/incidents', icon: Activity },
  { label: 'Noise Rules', path: '/noise-rules', icon: GitBranch },
  { label: 'Settings', path: '/settings', icon: Settings },
];

export default function Sidebar() {
  return (
    <aside className="flex w-full shrink-0 flex-col bg-ink-950 text-white lg:fixed lg:inset-y-0 lg:left-0 lg:w-72">
      <div className="flex h-20 items-center gap-3 px-5">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-cyan-400 text-ink-950">
          <ShieldCheck className="h-6 w-6" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-200">Ops Signal</p>
          <h1 className="text-lg font-semibold leading-tight">Alert Noise Reduction</h1>
        </div>
      </div>

      <nav className="flex gap-2 overflow-x-auto px-3 pb-4 lg:flex-col lg:overflow-visible lg:px-4">
        {navItems.map((item) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex min-w-fit items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? 'bg-white text-ink-950 shadow-sm'
                    : 'text-slate-300 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto hidden border-t border-white/10 p-5 lg:block">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">Reduction rate</p>
        <div className="mt-3 flex items-end gap-2">
          <span className="text-3xl font-semibold">66%</span>
          <span className="pb-1 text-sm text-emerald-300">this week</span>
        </div>
        <div className="mt-4 h-2 rounded-full bg-white/10">
          <div className="h-2 w-2/3 rounded-full bg-cyan-400" />
        </div>
      </div>
    </aside>
  );
}
