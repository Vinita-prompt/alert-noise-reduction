import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useState } from 'react';

const colors = {
  slate: '#64748b',
  navy: '#0f172a',
  teal: '#0f766e',
  tealLight: '#5eead4',
  blue: '#2563eb',
  violet: '#7c3aed',
  amber: '#f59e0b',
  rose: '#e11d48',
  emerald: '#059669',
};

const signalTrend = [
  { time: '08:00', incoming: 18, actionable: 7, noise: 11 },
  { time: '09:00', incoming: 34, actionable: 13, noise: 21 },
  { time: '10:00', incoming: 42, actionable: 15, noise: 27 },
  { time: '11:00', incoming: 51, actionable: 18, noise: 33 },
  { time: '12:00', incoming: 46, actionable: 19, noise: 27 },
  { time: '13:00', incoming: 63, actionable: 23, noise: 40 },
  { time: '14:00', incoming: 58, actionable: 20, noise: 38 },
];

const signalTrendRanges = {
  Today: signalTrend,
  '7 Days': [
    { time: 'Mon', incoming: 172, actionable: 61 }, { time: 'Tue', incoming: 198, actionable: 72 },
    { time: 'Wed', incoming: 184, actionable: 66 }, { time: 'Thu', incoming: 221, actionable: 81 },
    { time: 'Fri', incoming: 205, actionable: 74 }, { time: 'Sat', incoming: 149, actionable: 52 },
    { time: 'Sun', incoming: 186, actionable: 64 },
  ],
  '30 Days': [
    { time: 'W1', incoming: 1180, actionable: 445 }, { time: 'W2', incoming: 1324, actionable: 482 },
    { time: 'W3', incoming: 1272, actionable: 431 }, { time: 'W4', incoming: 1395, actionable: 468 },
  ],
};

const sourceComparison = [
  { source: 'Slack', signals: 86 },
  { source: 'Grafana', signals: 74 },
  { source: 'Jira', signals: 48 },
  { source: 'AppDyn', signals: 42 },
  { source: 'Nagios', signals: 36 },
  { source: 'T. Eyes', signals: 26 },
];

const decisionMix = [
  { name: 'Noise', value: 197, color: colors.violet },
  { name: 'Actionable', value: 115, color: colors.blue },
];

const incidentMix = [
  { name: 'Open', value: 4, color: colors.amber },
  { name: 'Investigating', value: 3, color: colors.rose },
  { name: 'Monitoring', value: 2, color: colors.blue },
  { name: 'Resolved', value: 5, color: colors.emerald },
];

const noiseBreakdown = [
  { type: 'Duplicate', count: 82, fill: '#7c3aed' },
  { type: 'Flapping', count: 31, fill: '#8b5cf6' },
  { type: 'Auto-resolved', count: 28, fill: '#a78bfa' },
  { type: 'Correlated', count: 24, fill: '#0f766e' },
  { type: 'Non-actionable', count: 21, fill: '#64748b' },
  { type: 'Stale', count: 11, fill: '#94a3b8' },
];

const correlationTrend = [
  { day: 'Mon', duplicate: 51, correlated: 18 },
  { day: 'Tue', duplicate: 63, correlated: 22 },
  { day: 'Wed', duplicate: 57, correlated: 19 },
  { day: 'Thu', duplicate: 74, correlated: 27 },
  { day: 'Fri', duplicate: 68, correlated: 24 },
  { day: 'Sat', duplicate: 44, correlated: 15 },
  { day: 'Sun', duplicate: 82, correlated: 24 },
];

const dailyActivityTrend = [
  { time: '08:00', alerts: 16, incidents: 2 },
  { time: '09:00', alerts: 31, incidents: 3 },
  { time: '10:00', alerts: 27, incidents: 1 },
  { time: '11:00', alerts: 35, incidents: 2 },
  { time: '12:00', alerts: 29, incidents: 1 },
  { time: '13:00', alerts: 48, incidents: 4 },
];

const dailyNoiseMix = [
  { name: 'Noise', value: 122, color: colors.violet },
  { name: 'Actionable', value: 64, color: colors.blue },
];

const dailyIncidentActivity = [
  { status: 'New', count: 9 },
  { status: 'Open', count: 4 },
  { status: 'Resolved', count: 5 },
];

const resolutionTrend = [
  { day: 'Mon', minutes: 132 },
  { day: 'Tue', minutes: 118 },
  { day: 'Wed', minutes: 126 },
  { day: 'Thu', minutes: 109 },
  { day: 'Fri', minutes: 114 },
  { day: 'Sat', minutes: 96 },
  { day: 'Today', minutes: 102 },
];

const tooltipStyle = {
  border: '1px solid #e2e8f0',
  borderRadius: '12px',
  boxShadow: '0 12px 30px rgba(15,23,42,0.08)',
  fontSize: '12px',
};

function ChartCard({ title, description, legend, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 ${className}`}>
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
        </div>
        {legend ? <div className="flex flex-wrap gap-3">{legend}</div> : null}
      </div>
      <div className="mt-5 h-56">{children}</div>
    </section>
  );
}

function LegendItem({ color, label }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-500">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function DonutLabel({ value, label }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="text-center">
        <p className="text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      </div>
    </div>
  );
}

export function IntroSignalChart() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-slate-950">From volume to focus</p>
          <p className="mt-1 text-xs text-slate-500">Illustrative signals across one day</p>
        </div>
        <div className="flex gap-3">
          <LegendItem color={colors.slate} label="Incoming" />
          <LegendItem color={colors.teal} label="Actionable" />
        </div>
      </div>
      <div className="mt-4 h-44" role="img" aria-label="Static line chart comparing incoming and actionable signals over the day">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={signalTrend} margin={{ top: 5, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#eef2f7" />
            <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="incoming" stroke={colors.slate} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="actionable" stroke={colors.teal} strokeWidth={2.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function OverviewCharts() {
  const [range, setRange] = useState('Today');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Incoming signals over time"
        description="Hourly signal volume and the portion that remained actionable."
        legend={(
          <div className="flex flex-wrap items-center gap-1">
            {Object.keys(signalTrendRanges).map((option) => (
              <button key={option} className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${range === option ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`} type="button" onClick={() => setRange(option)}>{option}</button>
            ))}
          </div>
        )}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={signalTrendRanges[range]} margin={{ top: 5, right: 5, left: -24, bottom: 0 }}>
            <defs>
              <linearGradient id="incomingGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.slate} stopOpacity={0.2} />
                <stop offset="100%" stopColor={colors.slate} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="#eef2f7" />
            <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Area type="monotone" dataKey="incoming" stroke={colors.slate} fill="url(#incomingGradient)" strokeWidth={2} />
            <Line type="monotone" dataKey="actionable" stroke={colors.teal} strokeWidth={2.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Source comparison" description="Static volume by originating channel or monitoring source.">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={sourceComparison} margin={{ top: 5, right: 5, left: -22, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#eef2f7" />
            <XAxis dataKey="source" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="signals" fill={colors.blue} radius={[6, 6, 0, 0]} maxBarSize={32} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Noise vs actionable alerts"
        description="How incoming signals were classified after noise checks."
        legend={<><LegendItem color={colors.violet} label="Noise" /><LegendItem color={colors.blue} label="Actionable" /></>}
      >
        <div className="relative h-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={decisionMix} dataKey="value" nameKey="name" innerRadius={66} outerRadius={88} paddingAngle={3} stroke="none">
                {decisionMix.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <DonutLabel value="63%" label="reduced" />
        </div>
      </ChartCard>

      <ChartCard
        title="Resolved vs open incidents"
        description="Incident state for the selected operational day."
        legend={<><LegendItem color={colors.amber} label="Open" /><LegendItem color={colors.rose} label="Investigating" /><LegendItem color={colors.blue} label="Monitoring" /><LegendItem color={colors.emerald} label="Resolved" /></>}
      >
        <div className="relative h-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={incidentMix} dataKey="value" nameKey="name" innerRadius={66} outerRadius={88} paddingAngle={3} stroke="none">
                {incidentMix.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <DonutLabel value="14" label="incidents" />
        </div>
      </ChartCard>
    </div>
  );
}

export function NoiseCharts() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
      <ChartCard title="Noise type breakdown" description="Signals classified as noise today, grouped by explanation.">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart layout="vertical" data={noiseBreakdown} margin={{ top: 0, right: 15, left: 18, bottom: 0 }}>
            <CartesianGrid horizontal={false} stroke="#eef2f7" />
            <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis type="category" dataKey="type" width={88} axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={18}>
              {noiseBreakdown.map((entry) => <Cell key={entry.type} fill={entry.fill} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title="Correlation & deduplication"
        description="Weekly counts of repeated and related signals removed from operator queues."
        legend={<><LegendItem color={colors.violet} label="Duplicates" /><LegendItem color={colors.teal} label="Correlated" /></>}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={correlationTrend} margin={{ top: 5, right: 5, left: -24, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#eef2f7" />
            <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="duplicate" stroke={colors.violet} strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="correlated" stroke={colors.teal} strokeWidth={2.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

export function DailyCharts() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartCard
        title="Daily alert & incident trend"
        description="Today’s alert volume with incident candidates shown separately."
        legend={<><LegendItem color={colors.blue} label="Alerts" /><LegendItem color={colors.rose} label="Incidents" /></>}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={dailyActivityTrend} margin={{ top: 5, right: 5, left: -24, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#eef2f7" />
            <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="alerts" stroke={colors.blue} strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="incidents" stroke={colors.rose} strokeWidth={2.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Resolution time trend" description="Average minutes to resolution over the last seven days.">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={resolutionTrend} margin={{ top: 5, right: 5, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#eef2f7" />
            <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} unit="m" />
            <Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${value} min`, 'Average']} />
            <Bar dataKey="minutes" fill={colors.teal} radius={[6, 6, 0, 0]} maxBarSize={30} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard
        title="Noise vs actionable"
        description="Today’s alert decisions after classification and correlation."
        legend={<><LegendItem color={colors.violet} label="Noise" /><LegendItem color={colors.blue} label="Actionable" /></>}
      >
        <div className="relative h-full">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={dailyNoiseMix} dataKey="value" nameKey="name" innerRadius={62} outerRadius={84} paddingAngle={3} stroke="none">
                {dailyNoiseMix.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
          <DonutLabel value="65.6%" label="noise reduced" />
        </div>
      </ChartCard>
      <ChartCard title="Incident activity" description="New, still-open, and resolved incidents for the selected day.">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dailyIncidentActivity} margin={{ top: 5, right: 5, left: -24, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#eef2f7" />
            <XAxis dataKey="status" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="count" fill={colors.teal} radius={[6, 6, 0, 0]} maxBarSize={42} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

export function IncidentMiniChart() {
  const data = [
    { time: '09:20', latency: 0.5 },
    { time: '09:50', latency: 1.2 },
    { time: '10:20', latency: 2.4 },
    { time: '10:50', latency: 2.8 },
    { time: '11:20', latency: 1.7 },
    { time: '11:36', latency: 0.6 },
  ];

  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-slate-900">Supporting signal</p>
          <p className="mt-0.5 text-[10px] text-slate-400">Latency normalized after resolution</p>
        </div>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-emerald-600">Recovered</span>
      </div>
      <div className="mt-3 h-24" role="img" aria-label="Static latency trend showing recovery after incident resolution">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
            <defs>
              <linearGradient id="incidentGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.rose} stopOpacity={0.24} />
                <stop offset="100%" stopColor={colors.rose} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="latency" stroke={colors.rose} fill="url(#incidentGradient)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
