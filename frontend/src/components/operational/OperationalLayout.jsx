import { Archive, BellRing, BrainCircuit, CalendarDays, ChevronDown, DatabaseZap, FileClock, History, LayoutDashboard, LogOut, Menu, MonitorCog, PlugZap, Settings, ShieldCheck, Siren, SlidersHorizontal, Wrench, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';

const primary = [
  ['Overview', '/overview', LayoutDashboard], ['Live Alerts', '/live-alerts', BellRing],
  ['Evidence History', '/evidence-history', FileClock], ['Incidents & Problems', '/incidents', Siren],
  ['Monitoring Sources', '/monitoring-sources', MonitorCog], ['Settings', '/settings', Settings],
];
const admin = [
  ['Alert Dataset', '/noise-analysis', DatabaseZap], ['Model Evaluation', '/model-evaluation', BrainCircuit],
  ['Evidence Backfill', '/evidence-backfill', Archive], ['Slack Data', '/slack-data', History],
  ['Diagnostics', '/diagnostics', Wrench], ['Integrations', '/integrations', PlugZap],
  ['Daily Updates', '/daily-updates', CalendarDays],
];
const workspaceTitles = [
  ['AppDynamics', '/appdynamics'], ['Grafana', '/grafana'], ['Nagios', '/nagios'],
];

function Mark() { return <Link className="flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300" to="/overview"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0F766E] text-white"><ShieldCheck className="h-5 w-5" /></span><span><strong className="block text-base tracking-tight text-white">CommandCenter</strong><span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Alert operations</span></span></Link>; }
function Items({ items, close }) { return items.map(([label, path, Icon]) => <NavLink key={path} to={path} onClick={close} className={({ isActive }) => `flex items-center gap-3 rounded-lg border-l-2 px-3 py-2.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300 ${isActive ? 'border-[#2DD4BF] bg-slate-700 text-white' : 'border-transparent text-slate-300 hover:bg-slate-800 hover:text-white'}`}><Icon className="h-4 w-4" /><span>{label}</span></NavLink>); }

export default function OperationalLayout() {
  const [mobileOpen, setMobileOpen] = useState(false); const [adminOpen, setAdminOpen] = useState(true);
  const auth = useAuth(); const navigate = useNavigate(); const { pathname } = useLocation();
  const title = [...primary, ...admin, ...workspaceTitles].find(([, path]) => pathname.startsWith(path))?.[0] || (pathname.startsWith('/evidence/') ? 'Evidence Collection' : 'CommandCenter');
  useEffect(() => { document.title = `${title} · CommandCenter`; }, [title]);
  async function signOut() { await auth.logout(); navigate('/login', { replace: true }); }
  const sidebar = <><div className="flex h-[72px] items-center justify-between border-b border-slate-700 px-5"><Mark /><button className="text-slate-300 lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X className="h-5 w-5" /></button></div><nav className="flex-1 overflow-y-auto px-3 py-5" aria-label="Primary navigation"><div className="space-y-1"><Items items={primary} close={() => setMobileOpen(false)} /></div>{auth.isAdmin ? <div className="mt-7 border-t border-slate-700 pt-4"><button className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400" type="button" onClick={() => setAdminOpen((value) => !value)}><span>Admin</span><ChevronDown className={`h-4 w-4 transition ${adminOpen ? 'rotate-180' : ''}`} /></button>{adminOpen ? <div className="mt-1 space-y-1"><Items items={admin} close={() => setMobileOpen(false)} /></div> : null}</div> : null}</nav><div className="border-t border-slate-700 p-4"><div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#CCFBF1] text-xs font-bold text-[#0F766E]">{String(auth.user?.name || 'U').split(/\s+/).map((value) => value[0]).join('').slice(0,2).toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-white">{auth.user?.name}</p><p className="truncate text-[10px] text-slate-400">{(auth.user?.roles || []).join(', ').replaceAll('_', ' ')}</p></div><button className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white" type="button" onClick={signOut} aria-label="Sign out"><LogOut className="h-4 w-4" /></button></div></div></>;
  return <div className="min-h-screen bg-[#F8FAFC] text-[#172033]"><aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-[#1F2937] lg:flex">{sidebar}</aside><div className="lg:pl-64"><header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-[#E2E8F0] bg-white px-5 sm:px-8"><div className="flex items-center gap-3"><button className="rounded-lg border border-slate-200 p-2 text-slate-600 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></button><div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748B]">CommandCenter</p><h1 className="mt-0.5 text-sm font-semibold">{title}</h1></div></div><div className="flex items-center gap-3"><span className="hidden items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-teal-800 sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-teal-500" />Read-only · Shadow</span><Link className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" to="/settings" aria-label="Open settings"><SlidersHorizontal className="h-4 w-4" /></Link></div></header><main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-7 lg:px-8 lg:py-8"><Outlet /></main></div>{mobileOpen ? <div className="fixed inset-0 z-50 lg:hidden"><button className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileOpen(false)} aria-label="Close navigation overlay" /><aside className="relative flex h-full w-[min(320px,88vw)] flex-col bg-[#1F2937] shadow-xl">{sidebar}</aside></div> : null}</div>;
}
