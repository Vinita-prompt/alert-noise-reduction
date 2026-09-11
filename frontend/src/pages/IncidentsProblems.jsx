import { useSearchParams } from 'react-router-dom';
import AccIncidents from './AccIncidents.jsx';
import AccProblems from './AccProblems.jsx';

export default function IncidentsProblems() {
  const [params, setParams] = useSearchParams(); const tab = params.get('tab') === 'problems' ? 'problems' : 'incidents';
  return <div className="space-y-5"><header><p className="cc-eyebrow">Jira workflow</p><h1 className="cc-title">Incidents &amp; Problems</h1><p className="cc-subtitle">Read-only operational records and the alerts linked to them.</p></header><div className="inline-flex rounded-xl border border-slate-200 bg-white p-1" role="tablist">{[['incidents','Incidents'],['problems','Problems']].map(([value,label]) => <button key={value} role="tab" aria-selected={tab === value} className={`rounded-lg px-5 py-2 text-sm font-semibold ${tab === value ? 'bg-[#1F2937] text-white' : 'text-slate-600 hover:bg-slate-50'}`} onClick={() => setParams(value === 'incidents' ? {} : { tab: value })}>{label}</button>)}</div><div>{tab === 'incidents' ? <AccIncidents /> : <AccProblems />}</div></div>;
}
