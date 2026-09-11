import Badge from '../common/Badge.jsx';
import Card from '../common/Card.jsx';
import { getDeliveryChannel, getMonitoringSource } from '../../utils/alertSource.js';

function formatDate(dateString) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateString));
}

function formatNumber(value) {
  return new Intl.NumberFormat('en').format(Number(value || 0));
}

function formatResponders(responders) {
  if (!Array.isArray(responders) || responders.length === 0) {
    return 'No responder yet';
  }

  return responders
    .map((responder) => {
      if (!responder) return null;
      if (typeof responder === 'string') return responder;
      return responder.displayName || responder.responderName || responder.name || responder.id || responder.accountId || responder.teamId || null;
    })
    .filter(Boolean)
    .slice(0, 2)
    .join(', ') || 'No responder yet';
}

export default function AlertsTable({ alerts, loadedCount, meta = {}, onSelectAlert }) {
  const totalCount = meta.totalCount ?? alerts.length;
  const displayLimit = meta.limit || loadedCount || alerts.length;
  const isLimited = totalCount > displayLimit;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">Alert stream</h3>
          <p className="text-sm text-slate-500">
            {formatNumber(totalCount)} total alerts stored.
            {' '}
            Showing {formatNumber(alerts.length)} of the latest {formatNumber(displayLimit)} loaded alerts.
            {isLimited ? ' Full history stays in PostgreSQL and details load on demand.' : ''}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[1540px] w-full divide-y divide-slate-200 text-left">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Alert</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Service</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Source Tool</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Delivery</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Priority</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Severity</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Status</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Acknowledgement</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Responders</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Classification
              </th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Occurrences
              </th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {alerts.length > 0 ? (
              alerts.map((alert) => (
                <tr
                  key={alert.id}
                  onClick={() => onSelectAlert(alert)}
                  className="cursor-pointer transition hover:bg-cyan-50/50"
                >
                  <td className="px-5 py-4">
                    <div>
                      <p className="font-semibold text-slate-950">{alert.title}</p>
                      <p className="mt-1 text-sm text-slate-500">{alert.id}</p>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-medium text-slate-700">{alert.service}</p>
                    <p className="mt-1 text-sm text-slate-500">{alert.environment}</p>
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-medium text-slate-700">{getMonitoringSource(alert)}</p>
                    <p className="mt-1 text-sm text-slate-500">{alert.sourceAlertId || alert.jiraIssueKey || 'No source key'}</p>
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-medium text-slate-700">{getDeliveryChannel(alert)}</p>
                    <p className="mt-1 text-xs text-slate-500">{alert.jiraTicketId ? `Incident ${alert.jiraTicketId}` : 'No incident linked'}</p>
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-medium text-slate-700">{alert.priority || 'Not set'}</p>
                    <p className="mt-1 text-sm text-slate-500">{alert.openClosedState || 'unknown'}</p>
                  </td>
                  <td className="px-5 py-4">
                    <Badge tone={alert.severity}>{alert.severity}</Badge>
                  </td>
                  <td className="px-5 py-4">
                    <Badge tone={alert.status}>{alert.status}</Badge>
                  </td>
                  <td className="px-5 py-4">
                    <Badge tone={alert.acknowledgedStatus}>{alert.acknowledgedStatus || 'unacknowledged'}</Badge>
                    <p className="mt-1 text-xs text-slate-500">
                      {alert.acknowledgedAt ? `By ${alert.acknowledgedBy || 'operator'}` : 'Acknowledge first'}
                    </p>
                  </td>
                  <td className="px-5 py-4">
                    <p className="max-w-48 truncate text-sm font-medium text-slate-700">{formatResponders(alert.responders)}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {alert.responders?.some((responder) => responder?.needsNameMapping) ? 'Name mapping needed' : 'From Slack/JSM'}
                    </p>
                  </td>
                  <td className="px-5 py-4">
                    <Badge tone={alert.classification}>{alert.classification}</Badge>
                    <p className="mt-1 text-xs text-slate-500">
                      {Number.isFinite(Number(alert.confidenceScore)) ? `${alert.confidenceScore}% confidence` : 'No confidence'}
                    </p>
                  </td>
                  <td className="px-5 py-4 font-medium text-slate-700">{alert.occurrences}</td>
                  <td className="px-5 py-4 text-sm text-slate-500">{formatDate(alert.lastSeenAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-10 text-center text-sm text-slate-500" colSpan={12}>
                  No alerts match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
