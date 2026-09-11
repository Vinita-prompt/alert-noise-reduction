import Badge from '../common/Badge.jsx';
import Card from '../common/Card.jsx';

function formatDate(dateString) {
  if (!dateString) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateString));
}

export default function IncidentsTable({ incidents, onSelectIncident }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-200 px-5 py-4">
        <h3 className="text-lg font-semibold text-slate-950">Operations incidents</h3>
        <p className="text-sm text-slate-500">Incident lifecycle records from JSM Operations and actionable alert mappings.</p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[920px] w-full divide-y divide-slate-200 text-left">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Incident</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Service</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Severity</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Recurring</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Jira</th>
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {incidents.length > 0 ? (
              incidents.map((incident) => (
                <tr
                  key={incident.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => onSelectIncident(incident)}
                >
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-950">{incident.title}</p>
                    <p className="mt-1 text-sm text-slate-500">{incident.incidentKey || incident.jiraTicketId || incident.alertId || incident.id}</p>
                    {incident.status ? (
                      <p className="mt-1 text-xs text-slate-500">{incident.status}</p>
                    ) : null}
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-medium text-slate-700">{incident.service}</p>
                    <p className="mt-1 text-sm text-slate-500">{incident.environment}</p>
                  </td>
                  <td className="px-5 py-4">
                    <Badge tone={incident.severity}>{incident.severity}</Badge>
                  </td>
                  <td className="px-5 py-4">
                    <Badge tone={incident.recurringIncident ? 'high' : 'low'}>
                      {incident.recurringIncident ? 'Recurring' : 'New'}
                    </Badge>
                  </td>
                  <td className="px-5 py-4">
                    {incident.jiraTicketId ? (
                      <span className="font-semibold text-slate-900">{incident.jiraTicketId}</span>
                    ) : (
                      <span className="text-sm text-slate-500">Pending</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-500">{formatDate(incident.lastSeenAt)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-5 py-10 text-center text-sm text-slate-500" colSpan={6}>
                  No incident alerts found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
