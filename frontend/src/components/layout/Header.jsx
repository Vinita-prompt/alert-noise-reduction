import { Search } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import AlertNotificationButton from './AlertNotificationButton.jsx';

const pageMeta = {
  '/dashboard': {
    title: 'Dashboard',
    description: 'Operational overview of alert volume, incidents, and noise reduction.',
  },
  '/integrations': {
    title: 'Integrations',
    description: 'Connect, test, and synchronize alert sources and incident systems.',
  },
  '/monitoring': {
    title: 'Monitoring',
    description: 'Select a monitoring tool and entity to inspect live status, metrics, events, and source dashboards.',
  },
  '/sources': {
    title: 'Monitoring Sources',
    description: 'Drill into source-specific dashboards for AppDynamics, Grafana, Nagios, and future configured monitoring tools.',
  },
  '/alerts': {
    title: 'Alerts',
    description: 'Review incoming alerts, classifications, and suppression context.',
  },
  '/incidents': {
    title: 'Incidents',
    description: 'Track actionable alerts that need investigation or follow-up.',
  },
  '/noise-rules': {
    title: 'Noise Rules',
    description: 'Manage the rules that classify duplicate, stale, and low-signal alerts.',
  },
  '/settings': {
    title: 'Settings',
    description: 'Prepare integration surfaces for Slack, Jira, and monitoring tools.',
  },
};

export default function Header() {
  const { pathname } = useLocation();
  const meta = pageMeta[pathname] || pageMeta['/dashboard'];

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-4 backdrop-blur md:px-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-950">{meta.title}</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">{meta.description}</p>
        </div>

        <div className="flex w-full items-center gap-3 xl:max-w-xl">
          <label className="relative flex-1">
            <span className="sr-only">Global search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="h-10 w-full rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-2 focus:ring-cyan-100"
              placeholder="Search alerts, services, rules"
              type="search"
            />
          </label>
          <AlertNotificationButton />
        </div>
      </div>
    </header>
  );
}
