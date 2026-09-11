import {
  ArrowLeft,
  BellRing,
  Boxes,
  ChevronRight,
  CircleCheck,
  ExternalLink,
  FolderOpen,
  LayoutDashboard,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TableProperties,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  GrafanaDefinitionGrid,
  GrafanaDetailDrawer,
  GrafanaEmptyState,
  GrafanaLink,
  GrafanaPagination,
  GrafanaReadOnlyBadge,
  GrafanaRefreshButton,
  GrafanaStateBadge,
  GrafanaTags,
  formatGrafanaTimestamp,
} from '../components/grafana/GrafanaUi.jsx';
import { PageHeader, TableHead, TableShell } from '../components/operational/DemoUi.jsx';
import {
  getGrafanaWorkspaceActiveAlerts,
  getGrafanaWorkspaceAlertRule,
  getGrafanaWorkspaceAlertRules,
  getGrafanaWorkspaceDashboard,
  getGrafanaWorkspaceDashboards,
  getGrafanaWorkspaceFolders,
  getGrafanaWorkspaceOverview,
  getGrafanaWorkspacePanelData,
  getGrafanaWorkspacePanelRenderUrl,
} from '../services/api.js';

const TABS = [
  { icon: LayoutDashboard, id: 'overview', label: 'Overview' },
  { icon: TableProperties, id: 'dashboards', label: 'Dashboards' },
  { icon: SlidersHorizontal, id: 'alert-rules', label: 'Alert Rules' },
  { icon: BellRing, id: 'active-alerts', label: 'Active Alerts' },
  { icon: FolderOpen, id: 'folders', label: 'Folders' },
];

const DASHBOARD_TIME_RANGES = ['15m', '30m', '1h', '4h', '24h', '7d', '30d', '90d', '6mo', '1y'];
const DASHBOARD_SORT_OPTIONS = [
  { label: 'Name A–Z', value: 'name-asc' },
  { label: 'Name Z–A', value: 'name-desc' },
  { label: 'Recently Updated', value: 'updated-desc' },
];
const PANEL_RENDER_CONCURRENCY = 4;
const NATIVE_PANEL_TYPES = new Set([
  'bar chart',
  'barchart',
  'bargauge',
  'gauge',
  'panel',
  'pie chart',
  'piechart',
  'stat',
  'table',
  'text',
  'timeseries',
]);
let activePanelRenders = 0;
const panelRenderQueue = [];
const CHART_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#d97706', '#dc2626', '#0891b2', '#65a30d', '#c026d3', '#475569', '#ea580c', '#4f46e5', '#16a34a', '#be123c', '#0369a1', '#9333ea', '#a16207'];

function panelRenderAbortError() {
  return new DOMException('Panel render cancelled.', 'AbortError');
}

function drainPanelRenderQueue() {
  while (activePanelRenders < PANEL_RENDER_CONCURRENCY && panelRenderQueue.length) {
    const item = panelRenderQueue.shift();

    if (item.signal.aborted) {
      item.reject(panelRenderAbortError());
      continue;
    }

    activePanelRenders += 1;
    item.task()
      .then(item.resolve, item.reject)
      .finally(() => {
        activePanelRenders -= 1;
        drainPanelRenderQueue();
      });
  }
}

function schedulePanelRender(task, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(panelRenderAbortError());
      return;
    }

    panelRenderQueue.push({ reject, resolve, signal, task });
    drainPanelRenderQueue();
  });
}

function panelRenderDimensions(panel) {
  const panelType = normalizedPanelType(panel);
  if (panelType === 'table') return { height: 500, width: 1400 };
  if (['bargauge', 'gauge', 'stat'].includes(panelType)) return { height: 500, width: 720 };
  return { height: 500, width: 1000 };
}

function normalizedPanelType(panel) {
  return String(panel.type || 'panel').trim().toLowerCase();
}

function isTimeseriesPanel(panel) {
  return ['bar chart', 'barchart', 'pie chart', 'piechart', 'timeseries'].includes(normalizedPanelType(panel));
}

function isKpiPanel(panel) {
  return ['bargauge', 'gauge', 'stat'].includes(normalizedPanelType(panel));
}

function panelUsesFullGrafanaWidth(panel) {
  const position = panel.gridPosition || {};
  return normalizedPanelType(panel) === 'table'
    || Number(position.w || 0) >= 20;
}

function twoColumnPanelClass(panel, index, panels) {
  if (panelUsesFullGrafanaWidth(panel)) return 'md:col-span-2';

  let segmentStart = index;
  let segmentEnd = index;
  while (segmentStart > 0 && !panelUsesFullGrafanaWidth(panels[segmentStart - 1])) segmentStart -= 1;
  while (segmentEnd < panels.length - 1 && !panelUsesFullGrafanaWidth(panels[segmentEnd + 1])) segmentEnd += 1;

  const segmentLength = segmentEnd - segmentStart + 1;
  const positionInSegment = index - segmentStart;
  return segmentLength % 2 === 1 && positionInSegment === segmentLength - 1 ? 'md:col-span-2' : '';
}

function preferredKpiGridUnits(panel) {
  const width = Number(panel.gridPosition?.w || 0);
  if (width >= 18) return 4;
  if (width >= 7 || ['bargauge', 'gauge'].includes(normalizedPanelType(panel))) return 2;
  return 1;
}

function kpiPanelClass(panel, index, panels) {
  let occupiedUnits = 0;
  panels.slice(0, index).forEach((candidate) => {
    const units = preferredKpiGridUnits(candidate);
    if (occupiedUnits + units > 4) occupiedUnits = 0;
    occupiedUnits = (occupiedUnits + units) % 4;
  });

  const preferredUnits = preferredKpiGridUnits(panel);
  if (occupiedUnits + preferredUnits > 4) occupiedUnits = 0;
  const availableUnits = 4 - occupiedUnits;
  const units = index === panels.length - 1 ? Math.max(preferredUnits, availableUnits) : preferredUnits;
  return {
    1: '',
    2: 'sm:col-span-2 xl:col-span-2',
    3: 'sm:col-span-2 xl:col-span-3',
    4: 'sm:col-span-2 xl:col-span-4',
  }[units];
}

function formatPanelValue(value, unit, decimals) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number' && typeof value !== 'bigint') return String(value);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '—');
  const precision = Number.isInteger(Number(decimals)) ? Number(decimals) : Math.abs(numeric) >= 100 ? 0 : 2;
  const displayValue = unit === 'percentunit' ? numeric * 100 : numeric;
  const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits: precision }).format(displayValue);
  if (unit === 'percent' || unit === 'percentunit') return `${formatted}%`;
  if (unit === 'ms') return `${formatted} ms`;
  if (unit === 's') return `${formatted} s`;
  if (unit === 'bytes') return `${formatted} B`;
  return formatted;
}

function conciseMetricName(item, stripEmbeddedValue = false) {
  const name = String(item.name || '').trim();
  const trailingValue = name.match(/^(.*\S)\s+(-?[\d,.]+)(?:\s*(%|ms|s|B))?$/i);
  if (!trailingValue) return name;
  if (stripEmbeddedValue) return trailingValue[1];

  const nameValue = Number(trailingValue[2].replaceAll(',', ''));
  const dataValue = Number(item.value);
  const tolerance = Math.max(0.000001, Math.abs(dataValue) * 0.000001);
  return Number.isFinite(nameValue) && Math.abs(nameValue - dataValue) <= tolerance
    ? trailingValue[1]
    : name;
}

function panelThresholdColor(value, thresholds = []) {
  const colors = {
    blue: '#2563eb',
    green: '#059669',
    orange: '#d97706',
    purple: '#7c3aed',
    red: '#dc2626',
    yellow: '#ca8a04',
  };
  const ordered = [...thresholds].sort((left, right) => Number(left.value ?? Number.NEGATIVE_INFINITY) - Number(right.value ?? Number.NEGATIVE_INFINITY));
  const active = ordered.reduce((result, step) => (step.value === null || step.value === undefined || Number(value) >= Number(step.value) ? step : result), ordered[0]);
  return colors[String(active?.color || '').toLowerCase()] || '#0f766e';
}

function frameRows(frame) {
  const rowCount = Math.max(0, ...(frame.values || []).map((values) => Array.isArray(values) ? values.length : 0));
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    (frame.fields || []).map((field, fieldIndex) => ({ field, value: frame.values?.[fieldIndex]?.[rowIndex] ?? null }))
  ));
}

function numericPanelValues(data) {
  return (data.frames || []).flatMap((frame) => frameRows(frame).flatMap((row) => (
    row.filter(({ field, value }) => field.type === 'number' && Number.isFinite(Number(value)))
      .map(({ field, value }) => ({
        name: field.displayName || field.name || frame.name,
        unit: field.unit || data.display?.unit,
        value: Number(value),
      }))
  )));
}

function timeSeriesFieldModel(frame, field, data) {
  const genericName = field.displayName || field.name || frame.name || 'Series';
  const customName = String(field.labels?.custom || '').trim();
  const metricLabel = String(field.labels?.metric_name || genericName).split('|').at(-1)?.trim();
  let name = customName || genericName;

  if (customName && metricLabel) {
    const suffix = `: ${metricLabel}`;
    if (customName.toLowerCase().endsWith(suffix.toLowerCase())) {
      name = customName.slice(0, -suffix.length).trim();
    }
  }

  let unit = field.unit || data.display?.unit;
  const unitSource = `${metricLabel || ''} ${genericName}`;
  if (!unit && /\bms\b|\(ms\)/i.test(unitSource)) unit = 'ms';
  if (!unit && /\bseconds?\b|\(s\)/i.test(unitSource)) unit = 's';

  return { name, unit };
}

function timeSeriesModel(data) {
  const records = new Map();
  const series = [];
  const usedNames = new Set();
  (data.frames || []).forEach((frame) => {
    const timeIndex = (frame.fields || []).findIndex((field) => field.type === 'time' || /time/i.test(field.name || ''));
    if (timeIndex < 0) return;
    (frame.fields || []).forEach((field, fieldIndex) => {
      if (fieldIndex === timeIndex || field.type !== 'number') return;
      const fieldModel = timeSeriesFieldModel(frame, field, data);
      const baseName = fieldModel.name || `Series ${series.length + 1}`;
      let name = baseName;
      let suffix = 2;
      while (usedNames.has(name)) { name = `${baseName} ${suffix}`; suffix += 1; }
      usedNames.add(name);
      series.push({ name, unit: fieldModel.unit });
      const timestamps = frame.values?.[timeIndex] || [];
      const values = frame.values?.[fieldIndex] || [];
      values.forEach((value, index) => {
        const numeric = Number(value);
        const timestamp = timestamps[index];
        if (!Number.isFinite(numeric) || timestamp === undefined || timestamp === null) return;
        const epoch = Number.isFinite(Number(timestamp)) ? Number(timestamp) : new Date(timestamp).getTime();
        if (!Number.isFinite(epoch)) return;
        const record = records.get(epoch) || { timestamp: epoch };
        record[name] = numeric;
        records.set(epoch, record);
      });
    });
  });
  return { points: [...records.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-600), series };
}

function inferredPanelType(data) {
  const panelType = String(data.panelType || '').toLowerCase();
  if (panelType !== 'panel') return panelType;
  if (timeSeriesModel(data).points.length) return 'timeseries';
  if (numericPanelValues(data).length) return 'stat';
  return panelType;
}

function nativePanelHasVisualization(data) {
  const panelType = inferredPanelType(data);
  const hasFrameValues = (data.frames || []).some((frame) => (frame.values || []).some((values) => Array.isArray(values) && values.length));
  if (!hasFrameValues) return true;
  if (panelType === 'text') return Boolean(String(data.text || '').trim());
  if (panelType === 'table') return true;
  if (['stat', 'gauge', 'bargauge', 'pie chart', 'piechart'].includes(panelType)) return numericPanelValues(data).length > 0;
  if (['timeseries', 'bar chart', 'barchart'].includes(panelType)) return timeSeriesModel(data).points.length > 0;
  return false;
}

function chartSeriesColor(index) {
  return CHART_COLORS[index % CHART_COLORS.length];
}

function chartTimestamp(value) {
  const timestamp = new Date(Number(value));
  return Number.isNaN(timestamp.getTime()) ? String(value ?? '') : timestamp.toLocaleString([], {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    second: '2-digit',
  });
}

function chartTick(value, span) {
  const timestamp = new Date(Number(value));
  if (Number.isNaN(timestamp.getTime())) return '';
  return span >= 48 * 60 * 60 * 1000
    ? timestamp.toLocaleDateString([], { day: '2-digit', month: 'short' })
    : timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function chartThresholdBands(data, model) {
  const steps = (data.display?.thresholds || [])
    .filter((step) => step.value !== null && step.value !== undefined && Number.isFinite(Number(step.value)))
    .sort((left, right) => Number(left.value) - Number(right.value));
  if (!steps.length) return [];

  const actualValues = model.points.flatMap((point) => model.series.map((series) => Number(point[series.name])).filter(Number.isFinite));
  const configuredMax = data.display?.max !== null && data.display?.max !== undefined && Number.isFinite(Number(data.display.max))
    ? Number(data.display.max)
    : null;
  const actualMax = actualValues.length ? Math.max(...actualValues) : 0;

  return steps.map((step, index) => {
    const y1 = Number(step.value);
    const next = steps[index + 1];
    const y2 = next ? Number(next.value) : Math.max(configuredMax ?? actualMax, y1);
    if (y2 <= y1) return null;
    return { color: panelThresholdColor(y1, data.display?.thresholds), key: `${y1}-${y2}`, y1, y2 };
  }).filter(Boolean);
}

function CompactSeriesLegend({ highlightedSeries, onHighlight, series }) {
  return (
    <div aria-label="Chart series legend" className="grafana-series-legend mt-1.5 max-h-[72px] w-full overflow-y-auto border-t border-slate-100 pt-2">
      {series.map((item, index) => (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-[10px] font-semibold text-slate-600 transition-opacity" key={item.name} onMouseEnter={() => onHighlight(item.name)} onMouseLeave={() => onHighlight('')} style={{ opacity: highlightedSeries && highlightedSeries !== item.name ? 0.38 : 1 }} title={item.name}>
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: chartSeriesColor(index) }} />
          <span className="truncate">{item.name}</span>
        </span>
      ))}
    </div>
  );
}

function LightTooltip({ active, data, label, payload, series }) {
  if (!active || !payload?.length) return null;
  const units = Object.fromEntries(series.map((item) => [item.name, item.unit]));
  return (
    <div data-grafana-chart-tooltip className="max-w-[min(360px,80vw)] rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-xl backdrop-blur-sm">
      <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400">Timestamp</p>
      <p className="mt-0.5 text-[11px] font-semibold text-slate-700">{chartTimestamp(label)}</p>
      <div className="mt-2 max-h-52 space-y-1.5 overflow-y-auto border-t border-slate-100 pt-2">
        {payload.filter((item) => item.value !== null && item.value !== undefined).map((item) => (
          <div className="flex min-w-0 items-center justify-between gap-4 text-[11px]" key={item.dataKey}>
            <span className="flex min-w-0 items-center gap-1.5 font-medium text-slate-600" title={item.name}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="truncate">{item.name}</span>
            </span>
            <strong className="shrink-0 font-semibold text-slate-900">{formatPanelValue(item.value, units[item.dataKey], data?.display?.decimals)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function LightPanelVisualization({ data, detail = false }) {
  const [highlightedSeries, setHighlightedSeries] = useState('');
  const panelType = inferredPanelType(data);
  const seriesModel = timeSeriesModel(data);
  const numericValues = numericPanelValues(data);
  const chartHeight = detail ? 480 : 260;

  if (panelType === 'text') {
    const text = String(data.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? <p className="max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-700">{text}</p> : null;
  }

  if (panelType === 'table') {
    const frame = data.frames?.[0];
    const rows = frame ? frameRows(frame) : [];
    if (!frame || !rows.length) return null;
    return (
      <div className={`${detail ? 'max-h-[600px]' : 'max-h-[220px]'} w-full overflow-auto rounded-xl border border-slate-200 bg-white`}>
        <table className="w-full min-w-[520px] border-collapse text-left">
          <thead className="sticky top-0 bg-slate-50"><tr>{frame.fields.map((field, index) => <th className="border-b border-slate-200 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-500" key={`${field.name}-${index}`}>{field.displayName || field.name}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{rows.slice(0, 200).map((row, rowIndex) => <tr key={rowIndex}>{row.map(({ field, value }, cellIndex) => <td className="px-3 py-2 text-xs text-slate-700" key={`${rowIndex}-${cellIndex}`}>{field.type === 'time' ? formatGrafanaTimestamp(value) : formatPanelValue(value, field.unit || data.display?.unit, data.display?.decimals)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }

  if (panelType === 'stat') {
    const latestValues = [...numericValues].reverse().filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name) === index).slice(0, 12);
    return latestValues.length ? <div className="grafana-metric-grid">{latestValues.map((item) => { const label = conciseMetricName(item); return <div className="grafana-metric-cell flex min-h-[68px] flex-col justify-center" key={item.name}><p className="line-clamp-2 text-[11px] font-semibold leading-4 text-slate-500" title={label}>{label}</p><p className="mt-1 text-xl font-semibold tracking-tight" style={{ color: panelThresholdColor(item.value, data.display?.thresholds) }}>{formatPanelValue(item.value, item.unit, data.display?.decimals)}</p></div>; })}</div> : null;
  }

  if (panelType === 'gauge' || panelType === 'bargauge') {
    const latestValues = [...numericValues].reverse().filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name) === index).slice(0, 24);
    if (!latestValues.length) return null;
    const embeddedValueCount = latestValues.filter((item) => /\S\s+-?[\d,.]+(?:\s*(?:%|ms|s|B))?$/i.test(String(item.name || '').trim())).length;
    const stripEmbeddedValues = embeddedValueCount >= Math.max(2, Math.ceil(latestValues.length * 0.6));
    const hasConfiguredMin = data.display?.min !== null && data.display?.min !== undefined && Number.isFinite(Number(data.display.min));
    const hasConfiguredMax = data.display?.max !== null && data.display?.max !== undefined && Number.isFinite(Number(data.display.max));
    const sharedMin = hasConfiguredMin ? Number(data.display.min) : 0;
    const sharedMax = hasConfiguredMax
      ? Number(data.display.max)
      : Math.max(100, ...latestValues.map((item) => Number(item.value) || 0));
    return <div className="grafana-metric-grid">{latestValues.map((item) => {
      const percent = Math.max(0, Math.min(100, ((item.value - sharedMin) / Math.max(1, sharedMax - sharedMin)) * 100));
      const color = panelThresholdColor(item.value, data.display?.thresholds);
      const isZero = item.value === 0;
      const label = conciseMetricName(item, stripEmbeddedValues);
      return (
        <div className="grafana-metric-cell flex min-h-[72px] flex-col justify-center" key={item.name}>
          <p className="line-clamp-2 text-[11px] font-semibold leading-4 text-slate-500" title={label}>{label}</p>
          <p className="mt-1 text-xl font-semibold tracking-tight" style={{ color: isZero ? '#334155' : color }}>{formatPanelValue(item.value, item.unit, data.display?.decimals)}</p>
          <div aria-label={label} aria-valuemax={sharedMax} aria-valuemin={sharedMin} aria-valuenow={item.value} className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" role="meter">
            <div className="h-full rounded-full" style={{ backgroundColor: isZero ? '#cbd5e1' : color, width: isZero ? '14px' : `${Math.max(percent, 2)}%` }} />
          </div>
        </div>
      );
    })}</div>;
  }

  if (panelType === 'piechart' || panelType === 'pie chart') {
    const latest = [...numericValues].reverse().filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name) === index).slice(0, 8);
    return latest.length ? <ResponsiveContainer height={chartHeight} width="100%"><PieChart><Pie data={latest} dataKey="value" innerRadius="45%" nameKey="name" outerRadius="78%" paddingAngle={2}>{latest.map((item, index) => <Cell fill={CHART_COLORS[index % CHART_COLORS.length]} key={item.name} />)}</Pie><Tooltip contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12 }} /><Legend iconType="circle" wrapperStyle={{ color: '#475569', fontSize: 11 }} /></PieChart></ResponsiveContainer> : null;
  }

  if (seriesModel.points.length && seriesModel.series.length) {
    const Chart = panelType === 'barchart' || panelType === 'bar chart' ? BarChart : LineChart;
    const timeSpan = Math.max(0, Number(seriesModel.points.at(-1)?.timestamp || 0) - Number(seriesModel.points[0]?.timestamp || 0));
    const thresholdBands = chartThresholdBands(data, seriesModel);
    return (
      <div className="w-full" data-grafana-interactive-chart data-series-count={seriesModel.series.length}>
        <ResponsiveContainer height={chartHeight} width="100%">
          <Chart data={seriesModel.points} margin={{ bottom: 2, left: 0, right: 14, top: 8 }}>
            <CartesianGrid stroke="#e8edf3" strokeDasharray="3 3" vertical={false} />
            {thresholdBands.map((band) => <ReferenceArea fill={band.color} fillOpacity={0.055} ifOverflow="hidden" key={band.key} strokeOpacity={0} y1={band.y1} y2={band.y2} />)}
            <XAxis axisLine={{ stroke: '#cbd5e1' }} dataKey="timestamp" minTickGap={36} tick={{ fill: '#475569', fontSize: 10 }} tickFormatter={(value) => chartTick(value, timeSpan)} tickLine={false} />
            <YAxis axisLine={false} tick={{ fill: '#475569', fontSize: 10 }} tickLine={false} width={54} />
            <Tooltip content={<LightTooltip data={data} series={seriesModel.series} />} cursor={{ stroke: '#94a3b8', strokeDasharray: '4 4', strokeWidth: 1 }} filterNull shared wrapperStyle={{ outline: 'none', zIndex: 20 }} />
            {seriesModel.series.map((series, index) => panelType === 'barchart' || panelType === 'bar chart'
              ? <Bar dataKey={series.name} fill={chartSeriesColor(index)} fillOpacity={highlightedSeries && highlightedSeries !== series.name ? 0.18 : 0.9} key={series.name} maxBarSize={22} radius={[3, 3, 0, 0]} />
              : <Line connectNulls dataKey={series.name} dot={false} isAnimationActive={false} key={series.name} stroke={chartSeriesColor(index)} strokeOpacity={highlightedSeries && highlightedSeries !== series.name ? 0.16 : 1} strokeWidth={highlightedSeries === series.name ? 2.75 : 2} type="monotone" />)}
          </Chart>
        </ResponsiveContainer>
        <CompactSeriesLegend highlightedSeries={highlightedSeries} onHighlight={setHighlightedSeries} series={seriesModel.series} />
        {data.partial ? <p className="mt-1.5 text-[10px] text-amber-700">Showing real data from {data.returnedTargetCount} of {data.returnedTargetCount + data.failedTargetCount} configured query targets; unavailable targets were not substituted.</p> : null}
      </div>
    );
  }

  return null;
}

function panelCardHeight(panelType, status, detail) {
  if (detail && status === 'empty') return 'min-h-[220px]';
  if (detail && ['bargauge', 'gauge', 'stat'].includes(panelType)) return 'min-h-[320px]';
  if (detail) return 'min-h-[540px]';
  if (status === 'empty') return 'h-[132px] order-last';
  if (status === 'error') return 'h-[170px] order-last';
  if (panelType === 'stat') return 'min-h-[150px]';
  if (panelType === 'table') return 'h-[280px]';
  if (panelType === 'gauge' || panelType === 'bargauge') return 'min-h-[230px]';
  if (panelType === 'text') return 'min-h-[160px] max-h-[220px]';
  return 'h-[380px]';
}

async function renderedPanelContainsDataInk(imageBlob) {
  if (typeof createImageBitmap !== 'function') return true;
  let bitmap;
  try {
    bitmap = await createImageBitmap(imageBlob);
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 80;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return true;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, Math.round(canvas.height * 0.18), canvas.width, Math.round(canvas.height * 0.82)).data;
    let coloredPixels = 0;
    let darkPixels = 0;
    const pixelCount = pixels.length / 4;

    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const luminance = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
      if (Math.max(red, green, blue) - Math.min(red, green, blue) > 18 && luminance < 240) coloredPixels += 1;
      if (luminance < 185) darkPixels += 1;
    }

    return (coloredPixels / pixelCount) >= 0.0008 || (darkPixels / pixelCount) >= 0.006;
  } catch {
    return true;
  } finally {
    bitmap?.close?.();
  }
}

function GrafanaRenderedPanel({ className = '', dashboardUid, detail = false, hideHeader = false, onOpen, panel, range, refreshKey, variables }) {
  const [state, setState] = useState({ data: null, error: '', imageUrl: '', status: 'loading', strategy: '' });
  const [retryKey, setRetryKey] = useState(0);
  const panelType = String(panel.type || 'panel').toLowerCase();
  const nativeSupported = NATIVE_PANEL_TYPES.has(panelType);

  useEffect(() => {
    const abortController = new AbortController();
    let objectUrl = '';
    let timedOut = false;
    let timeoutId = null;
    const dimensions = detail ? { height: 620, width: 1600 } : panelRenderDimensions(panel);
    setState({ data: null, error: '', imageUrl: '', status: 'loading', strategy: '' });
    schedulePanelRender(
      async () => {
        timeoutId = window.setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, 35000);
        if (nativeSupported) {
          try {
            const data = await getGrafanaWorkspacePanelData(dashboardUid, panel.id, { range, refresh: refreshKey || undefined, variables }, { signal: abortController.signal });
            if (data.strategy === 'native' && nativePanelHasVisualization(data)) return { data, kind: 'native' };
          } catch (error) {
            if (error.name === 'AbortError') throw error;
          }
        }
        const renderUrl = getGrafanaWorkspacePanelRenderUrl(dashboardUid, panel.id, {
          ...dimensions,
          range,
          refresh: refreshKey || undefined,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          variables,
        });
        const response = await fetch(renderUrl, { signal: abortController.signal });
        return { kind: 'image', response };
      },
      abortController.signal,
    )
      .then(async (result) => {
        if (result.kind === 'native') {
          const hasText = Boolean(String(result.data.text || '').trim());
          const hasValues = (result.data.frames || []).some((frame) => (frame.values || []).some((values) => Array.isArray(values) && values.length));
          setState({ data: result.data, error: '', imageUrl: '', status: hasText || hasValues ? 'ready' : 'empty', strategy: 'native' });
          return;
        }
        const response = result.response;
        if (!response.ok) {
          let message = `Request failed with status ${response.status}`;
          try {
            const payload = await response.json();
            message = payload?.message || message;
          } catch {
            // Grafana render failures are not always JSON.
          }
          throw new Error(message);
        }

        const image = await response.blob();
        if (!image.size) {
          setState({ data: null, error: '', imageUrl: '', status: 'empty', strategy: 'light-image' });
          return;
        }
        if (!await renderedPanelContainsDataInk(image)) {
          setState({ data: null, error: '', imageUrl: '', status: 'empty', strategy: 'light-image-empty' });
          return;
        }

        objectUrl = URL.createObjectURL(image);
        setState({ data: null, error: '', imageUrl: objectUrl, status: 'ready', strategy: 'light-image' });
      })
      .catch((error) => {
        if (error.name !== 'AbortError' || timedOut) {
          setState({ data: null, error: timedOut ? 'The Grafana panel render timed out.' : error.message, imageUrl: '', status: 'error', strategy: '' });
        }
      })
      .finally(() => {
        if (timeoutId) window.clearTimeout(timeoutId);
      });

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      abortController.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [dashboardUid, detail, nativeSupported, panel, range, refreshKey, retryKey, variables]);

  const nativeVisualization = state.status === 'ready' && state.strategy === 'native'
    ? <LightPanelVisualization data={state.data} detail={detail} />
    : null;

  return (
    <article aria-label={`${panel.title} panel`} className={`grafana-dashboard-panel group flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition ${panelCardHeight(panelType, state.status, detail)} ${onOpen ? 'cursor-pointer hover:border-teal-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-teal-200' : ''} ${className}`} data-panel-type={panelType} data-render-strategy={state.strategy || state.status} onClick={onOpen} onKeyDown={(event) => { if (onOpen && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(); } }} role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined}>
      {!hideHeader ? <header className="flex min-h-[42px] shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
        <h3 className="line-clamp-2 text-xs font-semibold leading-4 text-slate-800" title={panel.title}>{panel.title}</h3>
        {panelType !== 'panel' ? <span className="shrink-0 rounded-md bg-slate-50 px-2 py-1 text-[8px] font-bold uppercase tracking-[0.1em] text-slate-400">{panelType}</span> : null}
      </header> : null}
      <div className={`flex min-h-0 flex-1 items-center justify-center bg-white ${detail ? 'p-4' : 'p-3'}`}>
        {state.status === 'loading' ? <div className="h-full min-h-24 w-full animate-pulse rounded-xl bg-slate-100" aria-label="Loading panel" /> : null}
        {state.status === 'empty' ? <div className="flex min-h-16 w-full items-center justify-center rounded-xl bg-slate-50 px-4 text-center"><p className="text-xs font-semibold text-slate-500">No data in selected time range</p></div> : null}
        {state.status === 'error' ? (
          <div className="max-w-sm text-center">
            <p className="text-sm font-semibold text-slate-700">Unable to load panel</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button className="rounded-lg bg-slate-950 px-3 py-2 text-[11px] font-semibold text-white" onClick={(event) => { event.stopPropagation(); setRetryKey((value) => value + 1); }} type="button">Retry</button>
              {panel.deepLink ? <a className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600" href={panel.deepLink} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank">Open in Grafana</a> : null}
            </div>
          </div>
        ) : null}
        {nativeVisualization}
        {state.status === 'ready' && state.strategy === 'native' && !nativeVisualization ? <div className="flex min-h-16 w-full items-center justify-center rounded-xl bg-slate-50 px-4 text-center"><p className="text-xs font-semibold text-slate-500">No data in selected time range</p></div> : null}
        {state.status === 'ready' && state.strategy === 'light-image' ? <img alt={`${panel.title} — live Grafana panel in light theme`} className="h-full max-h-full w-full bg-white object-contain" src={state.imageUrl} /> : null}
      </div>
    </article>
  );
}

function ErrorPanel({ message, onRetry, title = 'Grafana data could not be loaded.' }) {
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
      <p className="text-sm font-semibold text-rose-800">{title}</p>
      <p className="mt-1 text-xs leading-5 text-rose-700">{message}</p>
      <button className="mt-4 rounded-xl bg-rose-700 px-3.5 py-2 text-xs font-semibold text-white" onClick={onRetry} type="button">Try again</button>
    </div>
  );
}

function LoadingBlock({ height = 'h-52' }) {
  return <div className={`${height} animate-pulse rounded-2xl border border-slate-200 bg-white`} />;
}

function WorkspaceMetric({ icon: Icon, label, value }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-slate-500">{label}</p>
          <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{Number(value || 0).toLocaleString()}</p>
        </div>
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><Icon className="h-4 w-4" aria-hidden="true" /></span>
      </div>
      <p className="mt-3 text-[11px] text-slate-400">Real Grafana API data</p>
    </article>
  );
}

function OverviewTab({ error, loading, onRetry, overview }) {
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  if (loading && !overview) return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <LoadingBlock height="h-40" key={index} />)}</div>;

  const counts = overview?.counts || {};
  const metrics = [
    { icon: LayoutDashboard, label: 'Dashboards', value: counts.dashboards },
    { icon: FolderOpen, label: 'Folders', value: counts.folders },
    { icon: SlidersHorizontal, label: 'Alert Rules', value: counts.alertRules },
    { icon: BellRing, label: 'Active Alerts', value: counts.activeAlerts },
  ];

  return (
    <div>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => <WorkspaceMetric {...metric} key={metric.label} />)}
      </section>
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700"><CircleCheck className="h-5 w-5" aria-hidden="true" /></span>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-slate-400">Current state</p>
            <h2 className="mt-2 text-lg font-semibold text-slate-950">
              {counts.activeAlerts === 0 ? 'No Grafana alerts are currently firing.' : `${counts.activeAlerts.toLocaleString()} Grafana alert${counts.activeAlerts === 1 ? ' is' : 's are'} currently active.`}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
              This view reflects current alert instances. Absence from the active feed is not treated as resolved history.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function SearchField({ ariaLabel, onChange, onSubmit, placeholder, value }) {
  return (
    <form className="relative w-full max-w-xl" onSubmit={onSubmit}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
      <input aria-label={ariaLabel} className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-24 text-sm font-medium text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-100" name="search" onChange={onChange} placeholder={placeholder} value={value} />
      <button className="absolute right-1.5 top-1.5 h-8 rounded-lg bg-slate-950 px-3 text-[11px] font-semibold text-white" type="submit">Search</button>
    </form>
  );
}

function DashboardPanelSection({ children, count, description, layout = 'charts', title }) {
  const layoutClass = {
    charts: 'grid items-start gap-3 md:grid-cols-2',
    kpis: 'grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-4',
    tables: 'grid items-start gap-3',
  }[layout];

  if (!count) return null;

  return (
    <section className="mt-5" aria-label={title}>
      <div className="mb-2.5 flex items-end justify-between gap-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-950">{title}</h4>
          {description ? <p className="mt-0.5 text-[11px] text-slate-500">{description}</p> : null}
        </div>
        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{count} {count === 1 ? 'panel' : 'panels'}</span>
      </div>
      <div className={layoutClass}>{children}</div>
    </section>
  );
}

function PanelDetail({ backLabel = 'Back to Dashboard', dashboard, lastRefreshed, onBack, onRangeChange, onRefresh, panel, range, refreshKey, variables }) {
  if (!panel) {
    return (
      <section aria-label="Panel detail">
        <button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-sm" onClick={onBack} type="button"><ArrowLeft className="h-4 w-4" />{backLabel}</button>
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5"><h2 className="text-sm font-semibold text-amber-900">Panel not found</h2><p className="mt-1 text-xs text-amber-700">This panel is not present in the current Grafana dashboard definition.</p></div>
      </section>
    );
  }

  return (
    <section aria-label={`${panel.title} panel detail`}>
      <button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950" onClick={onBack} type="button"><ArrowLeft className="h-4 w-4" aria-hidden="true" />{backLabel}</button>

      <header className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-teal-700">Grafana panel</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{panel.title}</h2>
            <p className="mt-2 text-xs text-slate-500">Dashboard: <span className="font-semibold text-slate-700">{dashboard.title}</span></p>
            {lastRefreshed ? <p className="mt-1 text-[11px] text-slate-400">Data refreshed {lastRefreshed.toLocaleTimeString()}</p> : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex flex-wrap rounded-xl border border-slate-200 bg-slate-50 p-1" aria-label="Panel time range">
              {DASHBOARD_TIME_RANGES.map((value) => <button aria-pressed={range === value} className={`rounded-lg px-2.5 py-1.5 text-[10px] font-semibold transition ${range === value ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`} key={value} onClick={() => onRangeChange(value)} type="button">{value}</button>)}
            </div>
            <button className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-950 px-3.5 text-xs font-semibold text-white transition hover:bg-slate-800" onClick={onRefresh} type="button"><RefreshCw className="h-3.5 w-3.5" />Refresh</button>
            <GrafanaLink href={panel.deepLink} />
          </div>
        </div>
      </header>

      <div className="mt-3">
        <GrafanaRenderedPanel dashboardUid={dashboard.uid} detail hideHeader panel={panel} range={range} refreshKey={refreshKey} variables={variables} />
      </div>

      <details className="mt-3 rounded-2xl border border-slate-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-800">Panel Information</summary>
        <div className="mt-4"><GrafanaDefinitionGrid items={[
          { label: 'Dashboard', value: dashboard.title },
          { label: 'Panel ID', value: panel.id },
          { label: 'Type', value: panel.type },
          { label: 'Datasource', value: panel.datasource },
        ]} /></div>
      </details>
    </section>
  );
}

function DashboardDetail({ initialRange, initialView, onClose, onOpenPanel, onRangeChange, onViewChange, selectedPanel, uid }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [range, setRange] = useState(DASHBOARD_TIME_RANGES.includes(initialRange) ? initialRange : '1h');
  const [refreshKey, setRefreshKey] = useState(0);
  const [showAllSupporting, setShowAllSupporting] = useState(false);
  const [variableValues, setVariableValues] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const dashboard = await getGrafanaWorkspaceDashboard(uid);
      setData(dashboard);
      setLastRefreshed(new Date());
      setVariableValues(Object.fromEntries(
        (dashboard.variables || []).map((variable) => {
          const selected = variable.options?.find((option) => option.selected)?.value;
          const current = Array.isArray(variable.current) ? variable.current.join(',') : variable.current;
          return [variable.name, selected ?? current ?? ''];
        }),
      ));
    }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, [uid]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setRange(DASHBOARD_TIME_RANGES.includes(initialRange) ? initialRange : '1h');
  }, [initialRange]);
  useEffect(() => {
    if (selectedPanel) window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
  }, [selectedPanel]);
  useEffect(() => { setShowAllSupporting(false); }, [uid]);

  const panels = useMemo(() => (
    (data?.panels || [])
      .map((panel, index) => ({
        ...panel,
        gridPosition: panel.gridPosition || { h: 10, w: 24, x: 0, y: index * 10 },
      }))
      .sort((left, right) => (
        (left.gridPosition?.y || 0) - (right.gridPosition?.y || 0)
        || (left.gridPosition?.x || 0) - (right.gridPosition?.x || 0)
        || Number(left.id || 0) - Number(right.id || 0)
      ))
  ), [data]);

  function refreshPanels() {
    setLastRefreshed(new Date());
    setRefreshKey((value) => value + 1);
  }

  const selectedPanelData = selectedPanel ? panels.find((panel) => String(panel.id) === String(selectedPanel)) : null;
  const tableView = initialView === 'table';
  const kpiPanels = panels.filter(isKpiPanel);
  const tablePanels = panels.filter((panel) => normalizedPanelType(panel) === 'table');
  const chartPanels = panels.filter(isTimeseriesPanel);
  const primaryCharts = chartPanels.slice(0, Math.min(6, chartPanels.length));
  const supportingCharts = chartPanels.slice(primaryCharts.length);
  const visibleSupportingCharts = showAllSupporting ? supportingCharts : supportingCharts.slice(0, 6);
  const otherPanels = panels.filter((panel) => !isKpiPanel(panel) && normalizedPanelType(panel) !== 'table' && !isTimeseriesPanel(panel));
  const panelTypeCounts = panels.reduce((counts, panel) => {
    const type = normalizedPanelType(panel);
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});

  if (selectedPanel && data) {
    return <PanelDetail backLabel={tableView ? 'Back to Panels Table' : 'Back to Dashboard'} dashboard={data} lastRefreshed={lastRefreshed} onBack={() => onOpenPanel(null)} onRangeChange={(value) => { setRange(value); onRangeChange(value); }} onRefresh={refreshPanels} panel={selectedPanelData} range={range} refreshKey={refreshKey} variables={variableValues} />;
  }

  return (
    <section aria-label={data?.title || 'Dashboard details'}>
      <button className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:text-slate-950" onClick={onClose} type="button">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to Dashboards
      </button>

      {error ? <ErrorPanel message={error} onRetry={load} /> : null}
      {loading && !data ? <div className="mt-4"><LoadingBlock height="h-72" /></div> : null}
      {data ? (
        <div className={`mt-4 ${loading ? 'opacity-60' : ''}`}>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-start">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-teal-700">Dashboard</p>
                <h2 className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-950">{data.title}</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span>Folder: <strong className="font-semibold text-slate-700">{data.folderTitle || 'General'}</strong></span>
                  <span className="text-slate-300">·</span>
                  <span className="break-all font-mono text-[10px] text-slate-400">UID: {data.uid}</span>
                </div>
                {data.tags?.length ? <div className="mt-2"><GrafanaTags values={data.tags} /></div> : null}
              </div>
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center xl:justify-end">
                <div className="inline-flex w-fit rounded-xl border border-slate-200 bg-slate-50 p-1">
                  <button className={`rounded-lg px-3 py-2 text-[11px] font-semibold transition ${!tableView ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:text-slate-900'}`} onClick={() => onViewChange('dashboard')} type="button">Dashboard View</button>
                  <button className={`rounded-lg px-3 py-2 text-[11px] font-semibold transition ${tableView ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:text-slate-900'}`} onClick={() => onViewChange('table')} type="button">Panels Table</button>
                </div>
                <button className="inline-flex h-10 items-center gap-2 rounded-xl bg-slate-950 px-3.5 text-xs font-semibold text-white transition hover:bg-slate-800" onClick={refreshPanels} type="button"><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
                <GrafanaLink href={data.url} />
              </div>
            </div>

            <dl className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3" aria-label="Dashboard summary">
              {[
                ['Panels', data.panelCount],
                ['Timeseries', panelTypeCounts.timeseries || 0],
                ['Tables', panelTypeCounts.table || 0],
                ['Stats', panelTypeCounts.stat || 0],
                ['Data freshness', lastRefreshed?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })],
              ].map(([label, value]) => <div className="flex items-baseline gap-2 rounded-lg bg-slate-50 px-3 py-1.5" key={label}><dt className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-400">{label}</dt><dd className="text-[11px] font-semibold text-slate-700">{value ?? '—'}</dd></div>)}
            </dl>

            {data.variables?.length ? (
              <div className="mt-3 flex flex-wrap gap-3 border-t border-slate-100 pt-3">
                {data.variables.map((variable) => (
                  <label className="min-w-44 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400" key={variable.name}>
                    {variable.label || variable.name}
                    {variable.options?.length ? (
                      <select className="mt-1.5 block h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold normal-case tracking-normal text-slate-700 outline-none" onChange={(event) => setVariableValues((values) => ({ ...values, [variable.name]: event.target.value }))} value={variableValues[variable.name] || ''}>
                        {!variableValues[variable.name] ? <option value="">Select {variable.label || variable.name}</option> : null}
                        {variable.options.map((option) => <option key={`${variable.name}-${option.value}`} value={option.value}>{option.text}</option>)}
                      </select>
                    ) : <span className="mt-1.5 block rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-semibold normal-case tracking-normal text-slate-600">{String(variableValues[variable.name] || 'Dashboard default')}</span>}
                  </label>
                ))}
              </div>
            ) : null}

            <div className="mt-3 border-t border-slate-100 pt-3">
              <div className="flex flex-wrap rounded-xl border border-slate-200 bg-slate-50 p-1" aria-label="Dashboard time range">
                {DASHBOARD_TIME_RANGES.map((value) => <button aria-pressed={range === value} className={`rounded-lg px-2.5 py-1.5 text-[10px] font-semibold transition ${range === value ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`} key={value} onClick={() => { setRange(value); onRangeChange(value); }} type="button">{value}</button>)}
              </div>
            </div>
          </div>

          <section className="mt-5">
            <div className="mb-3 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <h3 className="text-base font-semibold text-slate-950">{tableView ? 'Panels Table' : 'Dashboard View'}</h3>
                <p className="mt-1 text-xs text-slate-500">{tableView ? `${data.panelCount.toLocaleString()} panel definitions · no datasource queries executed in this view` : `${data.panelCount.toLocaleString()} live panels · ${range} time range · real Grafana data`}</p>
              </div>
            </div>

            {!tableView && panels.length ? (
              <div aria-label={`${data.title} composed dashboard`}>
                <DashboardPanelSection count={kpiPanels.length} description="Compact real values and gauges" layout="kpis" title="Key metrics">
                  {kpiPanels.map((panel, index) => <GrafanaRenderedPanel className={kpiPanelClass(panel, index, kpiPanels)} dashboardUid={data.uid} key={`${data.uid}-${panel.id}`} onOpen={() => onOpenPanel(panel.id)} panel={panel} range={range} refreshKey={refreshKey} variables={variableValues} />)}
                </DashboardPanelSection>

                <DashboardPanelSection count={primaryCharts.length} description="Highest-positioned chart panels from the Grafana grid" title="Primary charts">
                  {primaryCharts.map((panel, index) => <GrafanaRenderedPanel className={twoColumnPanelClass(panel, index, primaryCharts)} dashboardUid={data.uid} key={`${data.uid}-${panel.id}`} onOpen={() => onOpenPanel(panel.id)} panel={panel} range={range} refreshKey={refreshKey} variables={variableValues} />)}
                </DashboardPanelSection>

                <DashboardPanelSection count={tablePanels.length} description="Real table results with compact internal scrolling" layout="tables" title="Tables">
                  {tablePanels.map((panel) => <GrafanaRenderedPanel dashboardUid={data.uid} key={`${data.uid}-${panel.id}`} onOpen={() => onOpenPanel(panel.id)} panel={panel} range={range} refreshKey={refreshKey} variables={variableValues} />)}
                </DashboardPanelSection>

                <DashboardPanelSection count={supportingCharts.length} description="Additional signals kept available without competing with primary charts" title="Supporting charts">
                  {visibleSupportingCharts.map((panel, index) => <GrafanaRenderedPanel className={twoColumnPanelClass(panel, index, visibleSupportingCharts)} dashboardUid={data.uid} key={`${data.uid}-${panel.id}`} onOpen={() => onOpenPanel(panel.id)} panel={panel} range={range} refreshKey={refreshKey} variables={variableValues} />)}
                </DashboardPanelSection>
                {supportingCharts.length > 6 ? <button className="mt-3 w-full rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3 text-xs font-semibold text-slate-600 transition hover:border-teal-300 hover:bg-teal-50/40 hover:text-teal-800" onClick={() => setShowAllSupporting((value) => !value)} type="button">{showAllSupporting ? 'Show fewer supporting charts' : `Show ${supportingCharts.length - visibleSupportingCharts.length} more supporting charts`}</button> : null}

                <DashboardPanelSection count={otherPanels.length} description="Text and legacy panels retained from the real dashboard" title="Additional panels">
                  {otherPanels.map((panel, index) => <GrafanaRenderedPanel className={twoColumnPanelClass(panel, index, otherPanels)} dashboardUid={data.uid} key={`${data.uid}-${panel.id}`} onOpen={() => onOpenPanel(panel.id)} panel={panel} range={range} refreshKey={refreshKey} variables={variableValues} />)}
                </DashboardPanelSection>
              </div>
            ) : null}
            {!tableView && !panels.length ? <GrafanaEmptyState title="No panels returned" description="Grafana did not return renderable panels for this dashboard." /> : null}

            {tableView && panels.length ? (
              <div>
                <TableShell minWidth="820px">
                <TableHead headings={['Panel', 'Type', 'Datasource', 'Panel ID', '']} />
                <tbody className="divide-y divide-slate-100">
                  {panels.map((panel) => (
                    <tr aria-label={`Open panel ${panel.title}`} className="cursor-pointer transition hover:bg-teal-50/50 focus:bg-teal-50/50 focus:outline-none" key={panel.id || panel.uid || panel.title} onClick={() => onOpenPanel(panel.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenPanel(panel.id); } }} role="button" tabIndex={0}>
                      <td className="px-5 py-4"><p className="text-sm font-semibold text-slate-900">{panel.title}</p></td>
                      <td className="px-5 py-4 text-xs font-semibold text-slate-600">{panel.type}</td>
                      <td className="px-5 py-4 text-xs text-slate-600">{panel.datasource}</td>
                      <td className="px-5 py-4 font-mono text-[11px] text-slate-500">{panel.id}</td>
                      <td className="px-5 py-4 text-right text-slate-300"><ChevronRight className="ml-auto h-4 w-4" aria-hidden="true" /></td>
                    </tr>
                  ))}
                </tbody>
                </TableShell>
              </div>
            ) : null}
          </section>

          {!tableView ? <details className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
            <summary className="cursor-pointer text-sm font-semibold text-slate-800">Technical Details</summary>
            <div className="mt-4"><GrafanaDefinitionGrid items={[
              { label: 'Folder', value: data.folderTitle },
              { label: 'UID', value: data.uid },
              { label: 'Panels', value: data.panelCount },
              { label: 'Created', value: formatGrafanaTimestamp(data.createdAt) },
              { label: 'Updated', value: formatGrafanaTimestamp(data.updatedAt) },
            ]} /></div>
            <pre className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-4 text-[11px] leading-5 text-slate-600">{JSON.stringify({
              createdAt: data.createdAt,
              folderTitle: data.folderTitle,
              folderUid: data.folderUid,
              id: data.id,
              panelCount: data.panelCount,
              tags: data.tags,
              title: data.title,
              uid: data.uid,
              updatedAt: data.updatedAt,
              url: data.url,
              variables: data.variables,
            }, null, 2)}</pre>
          </details> : null}
        </div>
      ) : null}
    </section>
  );
}

function formatDashboardInventoryDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function DashboardsTab({
  initialFolder,
  initialPage,
  initialRange,
  initialSearch,
  initialSort,
  initialTag,
  initialView,
  onInventoryStateChange,
  onOpenDashboard,
  onOpenPanel,
  onRangeChange,
  onViewChange,
  selectedDashboard,
  selectedPanel,
}) {
  const [draftSearch, setDraftSearch] = useState(initialSearch || '');
  const [search, setSearch] = useState(initialSearch || '');
  const [folderUid, setFolderUid] = useState(initialFolder || 'all');
  const [tag, setTag] = useState(initialTag || '');
  const [sort, setSort] = useState(initialSort || 'name-asc');
  const [page, setPage] = useState(initialPage || 1);
  const [result, setResult] = useState(null);
  const [folders, setFolders] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);

  useEffect(() => {
    setDraftSearch(initialSearch || '');
    setSearch(initialSearch || '');
    setFolderUid(initialFolder || 'all');
    setTag(initialTag || '');
    setSort(initialSort || 'name-asc');
    setPage(initialPage || 1);
  }, [initialFolder, initialPage, initialSearch, initialSort, initialTag]);

  const load = useCallback(async (refresh = false) => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setLoading(true);
    setError('');
    try {
      const response = await getGrafanaWorkspaceDashboards({ folderUid, page, pageSize: 25, refresh, search, sort, tag });
      if (requestSequence.current === sequence) setResult(response);
    } catch (requestError) {
      if (requestSequence.current === sequence) setError(requestError.message);
    } finally {
      if (requestSequence.current === sequence) setLoading(false);
    }
  }, [folderUid, page, search, sort, tag]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => {
    getGrafanaWorkspaceFolders({ pageSize: 50 }).then((response) => setFolders(response.items || [])).catch(() => setFolders([]));
  }, []);

  function submitSearch(event) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('search') || '').trim();
    setSearch(value);
    setPage(1);
    onInventoryStateChange({ page: 1, search: value });
  }

  function changeFolder(value) {
    setFolderUid(value);
    setPage(1);
    onInventoryStateChange({ folder: value, page: 1 });
  }

  function changeSort(value) {
    setSort(value);
    setPage(1);
    onInventoryStateChange({ page: 1, sort: value });
  }

  function changeTag(value) {
    setTag(value);
    setPage(1);
    onInventoryStateChange({ page: 1, tag: value });
  }

  function changePage(value) {
    setPage(value);
    onInventoryStateChange({ page: value });
  }

  const firstVisible = result?.pagination?.total ? ((result.pagination.page - 1) * result.pagination.pageSize) + 1 : 0;
  const lastVisible = result?.pagination?.total ? Math.min(result.pagination.page * result.pagination.pageSize, result.pagination.total) : 0;

  if (selectedDashboard) {
    return <DashboardDetail initialRange={initialRange} initialView={initialView} onClose={() => onOpenDashboard(null)} onOpenPanel={onOpenPanel} onRangeChange={onRangeChange} onViewChange={onViewChange} selectedPanel={selectedPanel} uid={selectedDashboard} />;
  }

  return (
    <div>
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-teal-700">Grafana inventory</p>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-slate-950">Dashboards</h2>
            {result?.pagination ? <p className="mt-1 text-xs font-semibold text-slate-500">{result.pagination.total.toLocaleString()} dashboards · {folders.length.toLocaleString()} folders</p> : <p className="mt-1 text-xs text-slate-500">Loading dashboard inventory…</p>}
            {result?.pagination?.total ? <p className="mt-1 text-xs text-slate-500">Showing {firstVisible.toLocaleString()}–{lastVisible.toLocaleString()} of {result.pagination.total.toLocaleString()}</p> : null}
          </div>
          <GrafanaRefreshButton loading={loading} onClick={() => load(true)} />
        </div>
        <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <SearchField ariaLabel="Search Grafana dashboards" onChange={(event) => setDraftSearch(event.target.value)} onSubmit={submitSearch} placeholder="Search dashboards" value={draftSearch} />
          <div className="grid gap-2 sm:grid-cols-3 xl:flex">
            <select aria-label="Filter dashboards by folder" className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 outline-none" onChange={(event) => changeFolder(event.target.value)} value={folderUid}>
              <option value="all">All folders</option>
              {folders.map((folder) => <option key={folder.uid} value={folder.uid}>{folder.title}</option>)}
            </select>
            <input aria-label="Filter dashboards by tag" className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 outline-none placeholder:text-slate-400" onChange={(event) => changeTag(event.target.value.trim())} placeholder="Exact tag" value={tag} />
            <select aria-label="Sort dashboards" className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 outline-none" onChange={(event) => changeSort(event.target.value)} value={sort}>
              {DASHBOARD_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        </div>
      </section>

      {error ? <div className="mt-4"><ErrorPanel message={error} onRetry={load} title="Unable to load dashboards" /></div> : null}
      {!error && loading && !result ? <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-6 py-10 text-center text-sm font-semibold text-slate-500">Loading dashboards...</div> : null}
      {!error && !loading && result?.items?.length === 0 ? <div className="mt-4"><GrafanaEmptyState title="No dashboards found" description="Adjust the dashboard name, folder, or exact tag filter." /></div> : null}
      {result?.items?.length ? (
        <div className={`mt-4 ${loading ? 'opacity-55' : ''}`}>
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]" aria-label="Grafana dashboard inventory">
            <div className="hidden grid-cols-[minmax(0,2fr)_minmax(130px,1fr)_minmax(160px,1fr)_130px_32px] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 md:grid">
              <span>Dashboard</span>
              <span>Folder</span>
              <span>Tags</span>
              <span>Updated</span>
              <span>Action</span>
            </div>
            <div className="divide-y divide-slate-100">
            {result.items.map((dashboard) => (
              <button aria-label={`Open ${dashboard.title}`} className="group relative grid w-full gap-3 px-5 py-4 text-left transition hover:bg-teal-50/40 focus:bg-teal-50/50 focus:outline-none md:grid-cols-[minmax(0,2fr)_minmax(130px,1fr)_minmax(160px,1fr)_130px_32px] md:items-center md:gap-4" key={dashboard.uid} onClick={() => onOpenDashboard(dashboard.uid)} type="button">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-950 group-hover:text-teal-800" title={dashboard.title}>{dashboard.title}</span>
                  <span className="mt-1 block truncate font-mono text-[10px] text-slate-400" title={dashboard.uid}>{dashboard.uid}</span>
                </span>
                <span className="min-w-0 text-xs font-semibold text-slate-600"><span className="mr-1 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 md:hidden">Folder</span>{dashboard.folderTitle || 'General'}</span>
                <span className="min-w-0">{dashboard.tags?.length ? <GrafanaTags values={dashboard.tags} limit={3} /> : <span className="text-xs text-slate-300">—</span>}</span>
                <span className="text-xs text-slate-500"><span className="mr-1 text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 md:hidden">Updated</span>{formatDashboardInventoryDate(dashboard.updatedAt)}</span>
                <span className="absolute right-5 mt-1 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-teal-700 md:static md:mt-0"><ChevronRight className="h-4 w-4" aria-hidden="true" /></span>
              </button>
            ))}
            </div>
          </section>
          <GrafanaPagination loading={loading} onPage={changePage} pagination={result.pagination} />
        </div>
      ) : null}
    </div>
  );
}

function RuleDetail({ onClose, uid }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await getGrafanaWorkspaceAlertRule(uid)); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  const annotationEntries = useMemo(() => Object.entries(data?.annotations || {}).filter(([key]) => !key.startsWith('__')), [data]);
  const labelEntries = useMemo(() => Object.entries(data?.labels || {}), [data]);

  return (
    <GrafanaDetailDrawer closeLabel="Back to alert rules" onClose={onClose} title={data?.title || 'Alert rule details'}>
      {error ? <ErrorPanel message={error} onRetry={load} /> : null}
      {loading && !data ? <LoadingBlock height="h-72" /> : null}
      {data ? (
        <div className={loading ? 'opacity-60' : ''}>
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-teal-700">Alert rule</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{data.title}</h2>
            <p className="mt-2 font-mono text-[11px] text-slate-400">{data.uid}</p>
          </section>

          <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
            <GrafanaDefinitionGrid items={[
              { label: 'Folder', value: data.folderTitle },
              { label: 'Rule group', value: data.ruleGroup },
              { label: 'Condition', value: data.condition },
              { label: 'For', value: data.duration },
              { label: 'No Data behavior', value: data.noDataState },
              { label: 'Error behavior', value: data.errorState },
              { label: 'Updated', value: formatGrafanaTimestamp(data.updatedAt) },
            ]} />
          </section>

          {data.thresholds?.length ? (
            <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-slate-950">Threshold</h3>
              <div className="mt-3 space-y-2">
                {data.thresholds.map((threshold, index) => <p className="rounded-xl bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600" key={`${threshold.refId}-${index}`}>{[threshold.refId, threshold.evaluator, threshold.values?.join(', ')].filter(Boolean).join(' · ')}</p>)}
              </div>
            </section>
          ) : null}

          {data.datasources?.length ? (
            <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-slate-950">Datasource</h3>
              <div className="mt-3 space-y-2">{data.datasources.map((source) => <div className="rounded-xl bg-slate-50 px-3 py-2" key={source.uid}><p className="text-xs font-semibold text-slate-700">{source.uid}</p>{source.type ? <p className="mt-1 text-[10px] text-slate-400">{source.type}</p> : null}</div>)}</div>
            </section>
          ) : null}

          {data.dashboard ? (
            <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Associated dashboard</p><p className="mt-2 text-sm font-semibold text-slate-900">{data.dashboard.title || data.dashboard.uid}</p>{data.dashboard.panelId ? <p className="mt-1 text-xs text-slate-500">Panel {data.dashboard.panelId}</p> : null}</div>
                <GrafanaLink href={data.dashboard.url} label="Open associated dashboard" subtle />
              </div>
            </section>
          ) : null}

          {annotationEntries.length ? (
            <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-slate-950">Annotations</h3>
              <dl className="mt-4 space-y-4">{annotationEntries.map(([key, value]) => <div key={key}><dt className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{key.replaceAll('_', ' ')}</dt><dd className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-700">{String(value)}</dd></div>)}</dl>
            </section>
          ) : null}

          {labelEntries.length ? <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold text-slate-950">Labels</h3><div className="mt-3"><GrafanaTags values={labelEntries.map(([key, value]) => `${key}: ${value}`)} limit={12} /></div></section> : null}

          {data.technicalDetails?.length ? (
            <details className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
              <summary className="cursor-pointer text-sm font-semibold text-slate-800">Technical Details</summary>
              <div className="mt-4 space-y-3">
                {data.technicalDetails.map((item, index) => (
                  <div className="rounded-xl border border-slate-100 bg-slate-50 p-3" key={`${item.refId}-${index}`}>
                    <GrafanaDefinitionGrid items={[
                      { label: 'Reference', value: item.refId },
                      { label: 'Query type', value: item.queryType },
                      { label: 'Model type', value: item.modelType },
                      { label: 'Datasource UID', value: item.datasourceUid },
                      { label: 'Datasource type', value: item.datasourceType },
                      { label: 'Expression', value: item.expression },
                    ]} />
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </GrafanaDetailDrawer>
  );
}

function AlertRulesTab({ onOpenRule, selectedRule }) {
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [folderUid, setFolderUid] = useState('all');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [folders, setFolders] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try { setResult(await getGrafanaWorkspaceAlertRules({ folderUid, page, pageSize: 20, refresh, search })); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, [folderUid, page, search]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => { getGrafanaWorkspaceFolders({ pageSize: 50 }).then((response) => setFolders(response.items || [])).catch(() => setFolders([])); }, []);

  return (
    <div>
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <SearchField ariaLabel="Search Grafana alert rules" onChange={(event) => setDraftSearch(event.target.value)} onSubmit={(event) => { event.preventDefault(); setSearch(draftSearch.trim()); setPage(1); }} placeholder="Search rule name or UID" value={draftSearch} />
          <select aria-label="Filter alert rules by folder" className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 outline-none" onChange={(event) => { setFolderUid(event.target.value); setPage(1); }} value={folderUid}>
            <option value="all">All folders</option>
            {folders.map((folder) => <option key={folder.uid} value={folder.uid}>{folder.title}</option>)}
          </select>
        </div>
      </section>
      <div className="mt-5 flex items-end justify-between gap-4"><div><h2 className="text-lg font-bold text-slate-950">Alert Rules</h2><p className="mt-1 text-xs text-slate-500">{result?.pagination ? `${result.pagination.total.toLocaleString()} rules · cached briefly on the backend` : 'Loading rule definitions…'}</p></div><GrafanaRefreshButton loading={loading} onClick={() => load(true)} /></div>
      {error ? <div className="mt-4"><ErrorPanel message={error} onRetry={load} /></div> : null}
      {!error && loading && !result ? <div className="mt-4"><LoadingBlock /></div> : null}
      {!error && !loading && result?.items?.length === 0 ? <div className="mt-4"><GrafanaEmptyState title="No alert rules matched" description="Adjust the rule name or folder filter." /></div> : null}
      {result?.items?.length ? (
        <div className={`mt-4 ${loading ? 'opacity-55' : ''}`}>
          <TableShell minWidth="1260px">
            <TableHead headings={['Rule', 'Folder / group', 'Condition', 'For', 'No Data', 'Error', 'Datasource', 'Updated', 'Association']} />
            <tbody className="divide-y divide-slate-100">
              {result.items.map((rule) => (
                <tr className="transition hover:bg-slate-50/70" key={rule.uid}>
                  <td className="px-5 py-4"><button className="max-w-[280px] text-left text-sm font-semibold text-slate-950 hover:text-teal-700" onClick={() => onOpenRule(rule.uid)} type="button">{rule.title}</button><p className="mt-1 font-mono text-[10px] text-slate-400">{rule.uid}</p></td>
                  <td className="px-5 py-4"><p className="text-xs font-semibold text-slate-700">{rule.folderTitle}</p>{rule.ruleGroup ? <p className="mt-1 text-[10px] text-slate-400">{rule.ruleGroup}</p> : null}</td>
                  <td className="px-5 py-4 font-mono text-xs text-slate-600">{rule.condition}</td>
                  <td className="px-5 py-4 text-xs font-semibold text-slate-600">{rule.duration}</td>
                  <td className="px-5 py-4 text-xs text-slate-600">{rule.noDataState}</td>
                  <td className="px-5 py-4 text-xs text-slate-600">{rule.errorState}</td>
                  <td className="px-5 py-4 text-xs text-slate-600">{rule.datasources?.map((source) => source.uid).join(', ')}</td>
                  <td className="px-5 py-4 text-xs text-slate-500">{formatGrafanaTimestamp(rule.updatedAt)}</td>
                  <td className="px-5 py-4 text-xs text-slate-600">{rule.dashboard ? <><p className="font-semibold">{rule.dashboard.title || rule.dashboard.uid}</p>{rule.dashboard.panelId ? <p className="mt-1 text-[10px] text-slate-400">Panel {rule.dashboard.panelId}</p> : null}</> : null}</td>
                </tr>
              ))}
            </tbody>
          </TableShell>
          <GrafanaPagination loading={loading} onPage={setPage} pagination={result.pagination} />
        </div>
      ) : null}
      {selectedRule ? <RuleDetail onClose={() => onOpenRule(null)} uid={selectedRule} /> : null}
    </div>
  );
}

function ActiveAlertsTab() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setResult(await getGrafanaWorkspaceActiveAlerts({ pageSize: 50 })); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 30000);
    return () => window.clearInterval(interval);
  }, [load]);

  return (
    <div>
      <section className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
        <div><p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Current alert instances</p><p className="mt-2 text-2xl font-semibold text-slate-950">{result ? `${result.total.toLocaleString()} active alerts` : 'Checking active alerts…'}</p>{result?.lastChecked ? <p className="mt-1 text-[11px] text-slate-400">Last checked {formatGrafanaTimestamp(result.lastChecked)} · refreshes every 30 seconds</p> : null}</div>
        <GrafanaRefreshButton loading={loading} onClick={load} />
      </section>
      {error ? <div className="mt-5"><ErrorPanel message={error} onRetry={load} /></div> : null}
      {!error && loading && !result ? <div className="mt-5"><LoadingBlock /></div> : null}
      {!error && result?.total === 0 ? <div className="mt-5"><GrafanaEmptyState title="No Grafana alerts are currently firing." description="Zero active alerts is a valid live state. No resolved history is inferred from this result." /></div> : null}
      {result?.items?.length ? (
        <section className={`mt-5 grid gap-4 ${loading ? 'opacity-55' : ''}`}>
          {result.items.map((alert, index) => (
            <article className="rounded-2xl border border-slate-200 bg-white p-5" key={alert.fingerprint || `${alert.rule}-${index}`}>
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-slate-950">{alert.rule || 'Grafana alert instance'}</h3>{alert.state ? <GrafanaStateBadge state={alert.state} /> : null}</div>{alert.activeSince ? <p className="mt-2 text-xs text-slate-500">Active since {formatGrafanaTimestamp(alert.activeSince)}</p> : null}</div>
                <GrafanaLink href={alert.sourceUrl} />
              </div>
              {Object.keys(alert.annotations || {}).length ? <div className="mt-4 rounded-xl bg-slate-50 p-4"><dl className="space-y-3">{Object.entries(alert.annotations).map(([key, value]) => <div key={key}><dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{key.replaceAll('_', ' ')}</dt><dd className="mt-1 text-xs leading-5 text-slate-700">{String(value)}</dd></div>)}</dl></div> : null}
              {Object.keys(alert.labels || {}).length ? <div className="mt-4"><GrafanaTags values={Object.entries(alert.labels).map(([key, value]) => `${key}: ${value}`)} limit={12} /></div> : null}
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function FoldersTab({ onOpenFolder }) {
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try { setResult(await getGrafanaWorkspaceFolders({ page, pageSize: 20, refresh, search })); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, [page, search]);
  useEffect(() => { load(false); }, [load]);

  return (
    <div>
      <section className="rounded-2xl border border-slate-200 bg-white p-4"><SearchField ariaLabel="Search Grafana folders" onChange={(event) => setDraftSearch(event.target.value)} onSubmit={(event) => { event.preventDefault(); setSearch(draftSearch.trim()); setPage(1); }} placeholder="Search folder name or UID" value={draftSearch} /></section>
      <div className="mt-5 flex items-end justify-between gap-4"><div><h2 className="text-lg font-bold text-slate-950">Folders</h2><p className="mt-1 text-xs text-slate-500">{result?.pagination ? `${result.pagination.total.toLocaleString()} folders` : 'Loading folders…'}</p></div><GrafanaRefreshButton loading={loading} onClick={() => load(true)} /></div>
      {error ? <div className="mt-4"><ErrorPanel message={error} onRetry={load} /></div> : null}
      {!error && loading && !result ? <div className="mt-4"><LoadingBlock /></div> : null}
      {!error && !loading && result?.items?.length === 0 ? <div className="mt-4"><GrafanaEmptyState title="No folders matched" description="Adjust the folder search and try again." /></div> : null}
      {result?.items?.length ? <section className={`mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3 ${loading ? 'opacity-55' : ''}`}>{result.items.map((folder) => <button className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-lg hover:shadow-slate-200/40" key={folder.uid} onClick={() => onOpenFolder(folder.uid)} type="button"><div className="flex items-start justify-between gap-4"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><FolderOpen className="h-4 w-4" /></span><span className="text-2xl font-semibold text-slate-950">{folder.dashboardCount.toLocaleString()}</span></div><h3 className="mt-4 text-sm font-semibold text-slate-950">{folder.title}</h3><p className="mt-1 break-all font-mono text-[10px] text-slate-400">{folder.uid}</p><p className="mt-3 text-[11px] font-semibold text-slate-500">{folder.dashboardCount === 1 ? '1 dashboard' : `${folder.dashboardCount.toLocaleString()} dashboards`}</p></button>)}</section> : null}
      <GrafanaPagination loading={loading} onPage={setPage} pagination={result?.pagination} />
    </div>
  );
}

export default function GrafanaWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamsRef = useRef(searchParams);
  const requestedTab = searchParams.get('tab') || 'dashboards';
  const activeTab = TABS.some((tab) => tab.id === requestedTab) ? requestedTab : 'overview';
  const selectedDashboard = searchParams.get('dashboard');
  const selectedPanel = searchParams.get('panel');
  const selectedRule = searchParams.get('rule');
  const initialFolder = searchParams.get('folder') || 'all';
  const requestedPage = Number(searchParams.get('page') || 1);
  const initialPage = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const initialSearch = searchParams.get('search') || '';
  const requestedSort = searchParams.get('sort') || 'name-asc';
  const initialSort = DASHBOARD_SORT_OPTIONS.some((option) => option.value === requestedSort) ? requestedSort : 'name-asc';
  const initialTag = searchParams.get('tag') || '';
  const requestedRange = searchParams.get('range') || '1h';
  const initialRange = DASHBOARD_TIME_RANGES.includes(requestedRange) ? requestedRange : '1h';
  const initialView = searchParams.get('view') === 'table' ? 'table' : 'dashboard';
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);

  const loadOverview = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try { setOverview(await getGrafanaWorkspaceOverview({ refresh })); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadOverview(false); }, [loadOverview]);

  function updateParams(values) {
    const next = new URLSearchParams(searchParamsRef.current);
    Object.entries(values).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '' || value === 'all') next.delete(key);
      else next.set(key, String(value));
    });
    searchParamsRef.current = next;
    setSearchParams(next);
  }

  function changeTab(tab) {
    const next = new URLSearchParams(searchParamsRef.current);
    next.set('tab', tab);
    next.delete('dashboard');
    next.delete('panel');
    next.delete('rule');
    next.delete('view');
    searchParamsRef.current = next;
    setSearchParams(next);
  }

  const connection = overview?.connection;

  return (
    <div>
      <PageHeader eyebrow="Live monitoring workspace" title="Grafana" description={activeTab === 'overview' ? 'Explore real dashboard metadata, alert definitions, folders, and current firing instances through the connected read-only Grafana service account.' : undefined} actions={<GrafanaReadOnlyBadge connected={!error && connection?.connected !== false} />} />

      <section className="mt-4 flex flex-col justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Connection</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-2 font-bold text-slate-900"><span className={`h-2 w-2 rounded-full ${error ? 'bg-rose-500' : connection?.connected ? 'bg-emerald-500' : 'bg-amber-400'}`} />{error ? 'Unavailable' : connection?.connected ? 'Connected' : 'Connecting'}</span>
            {connection?.version ? <><span className="text-slate-300">·</span><span className="font-semibold text-slate-600">Grafana {connection.version}</span></> : null}
            <span className="text-slate-300">·</span><span className="text-xs font-semibold text-slate-500">Explicit environment credentials</span>
          </div>
          {overview?.lastUpdated ? <p className="mt-2 text-[11px] text-slate-400">Last updated {formatGrafanaTimestamp(overview.lastUpdated)}</p> : null}
        </div>
        <GrafanaRefreshButton label="Refresh metadata" loading={loading} onClick={() => loadOverview(true)} />
      </section>

      <nav className="mt-4 flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5" aria-label="Grafana workspace sections">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return <button className={`flex min-w-fit items-center gap-2 rounded-xl px-3.5 py-2.5 text-xs font-semibold transition ${activeTab === tab.id ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-950'}`} key={tab.id} onClick={() => changeTab(tab.id)} type="button"><Icon className="h-3.5 w-3.5" aria-hidden="true" />{tab.label}</button>;
        })}
      </nav>

      <section className="mt-4">
        {activeTab === 'overview' ? <OverviewTab error={error} loading={loading} onRetry={loadOverview} overview={overview} /> : null}
        {activeTab === 'dashboards' ? <DashboardsTab initialFolder={initialFolder} initialPage={initialPage} initialRange={initialRange} initialSearch={initialSearch} initialSort={initialSort} initialTag={initialTag} initialView={initialView} onInventoryStateChange={updateParams} onOpenDashboard={(uid) => updateParams(uid ? { dashboard: uid, panel: null, range: initialRange, view: 'dashboard' } : { dashboard: null, panel: null, view: null })} onOpenPanel={(panel) => updateParams({ panel })} onRangeChange={(range) => updateParams({ range })} onViewChange={(view) => updateParams({ view: view === 'table' ? 'table' : null })} selectedDashboard={selectedDashboard} selectedPanel={selectedPanel} /> : null}
        {activeTab === 'alert-rules' ? <AlertRulesTab onOpenRule={(uid) => updateParams({ rule: uid })} selectedRule={selectedRule} /> : null}
        {activeTab === 'active-alerts' ? <ActiveAlertsTab /> : null}
        {activeTab === 'folders' ? <FoldersTab onOpenFolder={(uid) => updateParams({ folder: uid, tab: 'dashboards' })} /> : null}
      </section>

      <section className="mt-7 flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        <p className="text-xs leading-5 text-slate-500">Grafana access is read-only. Durable alert-state history has not been proven, so this workspace intentionally shows current instances without presenting an alert-history view.</p>
      </section>
    </div>
  );
}
