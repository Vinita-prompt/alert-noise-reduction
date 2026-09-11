import { useEffect, useMemo, useState } from 'react';
import Card from '../components/common/Card.jsx';
import PageState from '../components/common/PageState.jsx';
import IncidentDetailsDrawer from '../components/incidents/IncidentDetailsDrawer.jsx';
import IncidentsTable from '../components/incidents/IncidentsTable.jsx';
import { getIncidentByKey, getIncidents } from '../services/api.js';

export default function Incidents() {
  const [incidents, setIncidents] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [drawerError, setDrawerError] = useState(null);

  useEffect(() => {
    let isMounted = true;

    async function loadIncidents() {
      try {
        const data = await getIncidents();

        if (!isMounted) {
          return;
        }

        setIncidents(data);
        setStatus('success');
        setError(null);
      } catch (requestError) {
        if (!isMounted) {
          return;
        }

        setIncidents([]);
        setStatus('error');
        setError(requestError.message);
      }
    }

    loadIncidents();

    return () => {
      isMounted = false;
    };
  }, []);

  const recurringCount = useMemo(
    () => incidents.filter((incident) => incident.recurringIncident).length,
    [incidents],
  );
  const jiraCount = useMemo(
    () => incidents.filter((incident) => incident.jiraTicketId).length,
    [incidents],
  );

  async function handleSelectIncident(incident) {
    setSelectedIncident(incident);
    setDrawerError(null);

    const key = incident.incidentKey || incident.jiraTicketId || incident.id;

    if (!key) {
      return;
    }

    try {
      const fullIncident = await getIncidentByKey(key);
      setSelectedIncident((currentIncident) => (
        currentIncident?.id === incident.id ? fullIncident : currentIncident
      ));
    } catch (requestError) {
      setDrawerError(`Unable to load full incident details. ${requestError.message}`);
    }
  }

  if (status === 'loading') {
    return (
      <PageState
        title="Loading incidents"
        message="Fetching incident alerts from the backend."
        variant="loading"
      />
    );
  }

  return (
    <div className="space-y-5">
      {status === 'error' ? (
        <PageState
          title="Backend unavailable"
          message={`No demo incidents are shown. Start the backend or sync Jira alerts. ${error}`}
          variant="error"
        />
      ) : null}

      {incidents.length === 0 ? (
        <PageState title="No incidents found" message="The backend returned an empty incident list." />
      ) : null}

      {drawerError ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {drawerError}
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">Incident alerts</p>
          <p className="mt-3 text-3xl font-semibold text-slate-950">{incidents.length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">Recurring incidents</p>
          <p className="mt-3 text-3xl font-semibold text-slate-950">{recurringCount}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">ACC incidents linked</p>
          <p className="mt-3 text-3xl font-semibold text-slate-950">{jiraCount}</p>
        </Card>
      </section>

      <IncidentsTable incidents={incidents} onSelectIncident={handleSelectIncident} />
      <IncidentDetailsDrawer
        incident={selectedIncident}
        onClose={() => {
          setDrawerError(null);
          setSelectedIncident(null);
        }}
      />
    </div>
  );
}
