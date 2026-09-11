import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import OperationalLayout from '../components/operational/OperationalLayout.jsx';
import { RequireAdmin, RequireAuth } from '../context/AuthContext.jsx';
import AccIssueDetail from '../pages/AccIssueDetail.jsx';
import AlertDetailDemo from '../pages/AlertDetailDemo.jsx';
import AlertHistory from '../pages/AlertHistory.jsx';
import AppDynamicsWorkspace from '../pages/AppDynamicsWorkspace.jsx';
import DailyUpdates from '../pages/DailyUpdates.jsx';
import Diagnostics from '../pages/Diagnostics.jsx';
import EvidenceBackfill from '../pages/EvidenceBackfill.jsx';
import EvidenceHistory from '../pages/EvidenceHistory.jsx';
import GrafanaWorkspace from '../pages/GrafanaWorkspace.jsx';
import IncidentsProblems from '../pages/IncidentsProblems.jsx';
import IncidentVerificationReport from '../pages/IncidentVerificationReport.jsx';
import Integrations from '../pages/Integrations.jsx';
import LiveAlerts24h from '../pages/LiveAlerts24h.jsx';
import Login from '../pages/Login.jsx';
import ModelEvaluation from '../pages/ModelEvaluation.jsx';
import MonitoringSources from '../pages/MonitoringSources.jsx';
import NagiosWorkspace from '../pages/NagiosWorkspace.jsx';
import NoiseAnalysisDemo from '../pages/NoiseAnalysisDemo.jsx';
import OperationalOverview from '../pages/OperationalOverview.jsx';
import ProductSettings from '../pages/ProductSettings.jsx';
import SlackData from '../pages/SlackData.jsx';
import Signup from '../pages/Signup.jsx';

const admin = (element) => <RequireAdmin>{element}</RequireAdmin>;

function NavigateToEvidence() {
  const { alertId } = useParams();
  return <Navigate to={`/evidence/${encodeURIComponent(alertId || '')}`} replace />;
}

export default function AppRoutes() {
  return <Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/signup" element={<Signup />} />
    <Route element={<RequireAuth><OperationalLayout /></RequireAuth>}>
      <Route index element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<OperationalOverview />} />
      <Route path="/live-alerts" element={<LiveAlerts24h />} />
      <Route path="/live-alerts/:alertId" element={<AlertDetailDemo />} />
      <Route path="/evidence-history" element={<EvidenceHistory />} />
      <Route path="/evidence/:alertId" element={<IncidentVerificationReport />} />
      <Route path="/collect-evidence/:alertId" element={<NavigateToEvidence />} />
      <Route path="/incident-report/:alertId" element={<NavigateToEvidence />} />
      <Route path="/incidents" element={<IncidentsProblems />} />
      <Route path="/incidents/:incidentId" element={<AccIssueDetail />} />
      <Route path="/problem-candidates/:problemId" element={<AccIssueDetail />} />
      <Route path="/monitoring-sources" element={<MonitoringSources />} />
      <Route path="/settings" element={<ProductSettings />} />
      <Route path="/noise-analysis" element={admin(<NoiseAnalysisDemo />)} />
      <Route path="/alert-history" element={admin(<AlertHistory />)} />
      <Route path="/alert-history/:occurrenceId" element={admin(<AlertHistory />)} />
      <Route path="/model-evaluation" element={admin(<ModelEvaluation />)} />
      <Route path="/evidence-backfill" element={admin(<EvidenceBackfill />)} />
      <Route path="/slack-data" element={admin(<SlackData />)} />
      <Route path="/diagnostics" element={admin(<Diagnostics />)} />
      <Route path="/integrations" element={admin(<Integrations />)} />
      <Route path="/daily-updates" element={admin(<DailyUpdates />)} />
      <Route path="/appdynamics" element={<AppDynamicsWorkspace />} />
      <Route path="/appdynamics/:applicationId" element={<AppDynamicsWorkspace />} />
      <Route path="/grafana" element={<GrafanaWorkspace />} />
      <Route path="/nagios" element={<NagiosWorkspace />} />
      <Route path="/thousandeyes/*" element={<Navigate to="/monitoring-sources" replace />} />
      <Route path="/problem-candidates" element={<Navigate to="/incidents?tab=problems" replace />} />
      <Route path="*" element={<Navigate to="/overview" replace />} />
    </Route>
    <Route path="*" element={<Navigate to="/login" replace />} />
  </Routes>;
}
