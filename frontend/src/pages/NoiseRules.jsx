import { useEffect, useState } from 'react';
import PageState from '../components/common/PageState.jsx';
import NoiseRuleCard from '../components/rules/NoiseRuleCard.jsx';
import NoiseRuleDetailsDrawer from '../components/rules/NoiseRuleDetailsDrawer.jsx';
import { getRules, updateRule } from '../services/api.js';

const recommendedThresholds = [
  {
    label: 'Duplicate alerts',
    value: '3 matching alerts in 10 min',
  },
  {
    label: 'Flapping alerts',
    value: '5 open/recover state changes in 15 min',
  },
  {
    label: 'Auto-resolved alerts',
    value: 'Resolved within 12 min with no repeat for 10 min',
  },
  {
    label: 'Non-actionable alerts',
    value: 'Single low-impact event with no runbook action',
  },
  {
    label: 'Correlated alerts',
    value: 'Shared dependency or region within 20 min',
  },
  {
    label: 'Stale alerts',
    value: 'No source heartbeat or service ownership for 7 days',
  },
];

export default function NoiseRules() {
  const [rules, setRules] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [selectedRule, setSelectedRule] = useState(null);
  const [drawerMode, setDrawerMode] = useState('view');
  const [savingRule, setSavingRule] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(null);

  useEffect(() => {
    let isMounted = true;

    async function loadRules() {
      try {
        const data = await getRules();

        if (!isMounted) {
          return;
        }

        setRules(data);
        setStatus('success');
        setError(null);
      } catch (requestError) {
        if (!isMounted) {
          return;
        }

        setRules([]);
        setStatus('error');
        setError(requestError.message);
      }
    }

    loadRules();

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleSaveRule(rule, payload) {
    setSavingRule(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const savedRule = await updateRule(rule.id, payload);

      setRules((current) => current.map((item) => (
        (item.id || item.name) === (rule.id || rule.name) ? savedRule : item
      )));
      setDrawerMode('view');
      setSelectedRule(savedRule);
      setSaveSuccess(`${savedRule.name} saved.`);
    } catch (requestError) {
      setSaveError(requestError.message);
      throw requestError;
    } finally {
      setSavingRule(false);
    }
  }

  if (status === 'loading') {
    return (
      <PageState title="Loading noise rules" message="Fetching rules from the backend." variant="loading" />
    );
  }

  return (
    <div className="space-y-5">
      {status === 'error' ? (
        <PageState
          title="Backend unavailable"
          message={`No demo rules are shown. Start the backend to manage rules. ${error}`}
          variant="error"
        />
      ) : null}

      {rules.length === 0 ? (
        <PageState title="No noise rules found" message="The backend returned an empty rule list." />
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">Recommended starting thresholds</h3>
            <p className="mt-1 text-sm text-slate-500">
              Start conservative, review after one week of alert traffic, then tune by service criticality.
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {recommendedThresholds.map((threshold) => (
            <div key={threshold.label} className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{threshold.label}</p>
              <p className="mt-1 text-sm font-semibold text-slate-950">{threshold.value}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {rules.map((rule) => (
          <NoiseRuleCard
            key={rule.id || rule.name}
            rule={rule}
            onView={(nextRule) => {
              setSaveError(null);
              setSaveSuccess(null);
              setDrawerMode('view');
              setSelectedRule(nextRule);
            }}
            onEdit={(nextRule) => {
              setSaveError(null);
              setSaveSuccess(null);
              setDrawerMode('edit');
              setSelectedRule(nextRule);
            }}
          />
        ))}
      </div>

      <NoiseRuleDetailsDrawer
        error={saveError}
        rule={selectedRule}
        saving={savingRule}
        startEditing={drawerMode === 'edit'}
        success={saveSuccess}
        onClose={() => {
          setSaveError(null);
          setSaveSuccess(null);
          setDrawerMode('view');
          setSelectedRule(null);
        }}
        onSave={handleSaveRule}
      />
    </div>
  );
}
