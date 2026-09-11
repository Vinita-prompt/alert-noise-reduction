import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock3,
  Database,
  Gauge,
  KanbanSquare,
  Loader2,
  MessageSquare,
  Server,
  XCircle,
} from 'lucide-react';
import Card from '../common/Card.jsx';

const services = [
  { key: 'backend', label: 'Backend API', icon: Server },
  { key: 'database', label: 'PostgreSQL Database', icon: Database },
  { key: 'slack', label: 'Slack', icon: MessageSquare },
  { key: 'jira', label: 'Jira', icon: KanbanSquare },
  { key: 'grafana', label: 'Grafana', icon: Gauge },
  { key: 'appDynamics', label: 'AppDynamics', icon: Activity },
  { key: 'nagios', label: 'Nagios', icon: Server },
];

const statusConfig = {
  connected: {
    label: 'Connected',
    icon: CheckCircle2,
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  },
  checking: {
    label: 'Checking...',
    icon: Loader2,
    dot: 'bg-amber-400',
    badge: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
    spin: true,
  },
  disconnected: {
    label: 'Disconnected',
    icon: XCircle,
    dot: 'bg-red-500',
    badge: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30',
  },
  not_configured: {
    label: 'Not Configured',
    icon: Circle,
    dot: 'bg-slate-300',
    badge: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
  },
};

const overallConfig = {
  Healthy: {
    label: 'Healthy',
    icon: CheckCircle2,
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  },
  Warning: {
    label: 'Warning',
    icon: AlertTriangle,
    badge: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  },
  Critical: {
    label: 'Critical',
    icon: XCircle,
    badge: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30',
  },
  Checking: {
    label: 'Checking',
    icon: Loader2,
    badge: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
    spin: true,
  },
};

function formatLastChecked(value) {
  if (!value) {
    return 'Not checked yet';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Not checked yet';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function getServiceStatuses(health, loading) {
  if (health?.services) {
    return health.services;
  }

  if (health?.database) {
    const databaseStatus = health.database === 'connected' ? 'connected' : 'disconnected';
    const backendStatus = health.status === 'ok' ? 'connected' : 'disconnected';

    return {
      backend: backendStatus,
      database: databaseStatus,
      slack: 'not_configured',
      jira: 'not_configured',
      grafana: 'not_configured',
      appDynamics: 'not_configured',
      nagios: 'not_configured',
    };
  }

  const fallbackStatus = loading ? 'checking' : 'disconnected';
  return Object.fromEntries(services.map((service) => [service.key, fallbackStatus]));
}

function countConnected(serviceStatuses) {
  return services.filter((service) => serviceStatuses[service.key] === 'connected').length;
}

export default function SystemHealthCard({ health, loading, error }) {
  const serviceStatuses = getServiceStatuses(health, loading);
  const connectedServices = health?.connectedServices ?? countConnected(serviceStatuses);
  const totalServices = health?.totalServices ?? services.length;
  const overallStatus = loading && !health ? 'Checking' : health?.overallStatus || (error ? 'Critical' : 'Warning');
  const OverallIcon = overallConfig[overallStatus]?.icon || AlertTriangle;

  return (
    <Card className="p-5 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-950 dark:text-white">System Health</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Live service and integration status.</p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${overallConfig[overallStatus]?.badge}`}
          >
            <OverallIcon
              className={`h-3.5 w-3.5 ${overallConfig[overallStatus]?.spin ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            {overallConfig[overallStatus]?.label || overallStatus}
          </span>
        </div>

        {error ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            Unable to retrieve system health. Please check the backend service.
          </div>
        ) : null}

        <div className="space-y-3">
          {services.map((service) => {
            const status = serviceStatuses[service.key] || 'checking';
            const meta = statusConfig[status] || statusConfig.checking;
            const ServiceIcon = service.icon;
            const StatusIcon = meta.icon;

            return (
              <div key={service.key} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} />
                  <ServiceIcon className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                  <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                    {service.label}
                  </span>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${meta.badge}`}
                >
                  <StatusIcon className={`h-3.5 w-3.5 ${meta.spin ? 'animate-spin' : ''}`} aria-hidden="true" />
                  {meta.label}
                </span>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2 dark:border-slate-800">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
              Connected
            </p>
            <p className="mt-1 font-semibold text-slate-950 dark:text-white">
              {connectedServices} / {totalServices}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
              Last Checked
            </p>
            <p className="mt-1 flex items-center gap-1.5 font-semibold text-slate-950 dark:text-white">
              <Clock3 className="h-4 w-4 text-slate-400" aria-hidden="true" />
              {formatLastChecked(health?.lastChecked)}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
