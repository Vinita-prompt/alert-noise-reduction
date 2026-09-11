import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Card from '../common/Card.jsx';

const rangeOptions = [
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
  { value: 'all', label: 'All Stored' },
  { value: 'custom', label: 'Custom Date Range' },
];

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) {
    return null;
  }

  const values = Object.fromEntries(payload.map((item) => [item.dataKey, item.value]));

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-xl">
      <p className="font-semibold text-slate-950">{label}</p>
      <div className="mt-2 space-y-1">
        <p className="text-rose-600">Incidents: {values.incidents ?? 0}</p>
        <p className="text-cyan-600">Noise: {values.noise ?? 0}</p>
        <p className="font-semibold text-slate-950">Classified total: {values.total ?? 0}</p>
      </div>
    </div>
  );
}

export default function AlertTrendChart({
  customFrom,
  customTo,
  data,
  error,
  loading,
  onCustomFromChange,
  onCustomToChange,
  onRangeChange,
  range,
}) {
  return (
    <Card className="p-5">
      <div className="mb-6 flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">Alert trend</h3>
          <p className="text-sm text-slate-500">
            Date-wise incident and noise volume by original alert event date.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[190px_150px_150px]">
          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Date range
            <select
              className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              value={range}
              onChange={(event) => onRangeChange(event.target.value)}
            >
              {rangeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            From
            <input
              className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:bg-slate-50"
              disabled={range !== 'custom'}
              type="date"
              value={customFrom}
              onChange={(event) => onCustomFromChange(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            To
            <input
              className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium normal-case tracking-normal text-slate-700 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:bg-slate-50"
              disabled={range !== 'custom'}
              type="date"
              value={customTo}
              onChange={(event) => onCustomToChange(event.target.value)}
            />
          </label>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Unable to load alert trend. {error}
        </div>
      ) : null}

      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ left: -20, right: 20, top: 10, bottom: 32 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="label"
              interval="preserveStartEnd"
              minTickGap={24}
              tick={{ fill: '#64748b', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              angle={data.length > 14 ? -30 : 0}
              textAnchor={data.length > 14 ? 'end' : 'middle'}
              height={data.length > 14 ? 58 : 32}
            />
            <YAxis tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} />
            <Tooltip content={<TrendTooltip />} />
            <Legend iconType="circle" />
            <Line
              type="monotone"
              dataKey="total"
              name="Total"
              stroke="#0f172a"
              strokeWidth={3}
              dot={{ r: 3, strokeWidth: 2 }}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="noise"
              name="Noise"
              stroke="#06b6d4"
              strokeWidth={3}
              dot={{ r: 3, strokeWidth: 2 }}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="incidents"
              name="Incidents"
              stroke="#dc2626"
              strokeWidth={3}
              dot={{ r: 3, strokeWidth: 2 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        {loading ? 'Refreshing chart data...' : 'Auto-refreshes every 30 seconds from the backend.'}
      </p>
    </Card>
  );
}
