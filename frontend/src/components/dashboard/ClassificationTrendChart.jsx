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

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) {
    return null;
  }

  const values = Object.fromEntries(payload.map((item) => [item.dataKey, item.value]));

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-xl">
      <p className="font-semibold text-slate-950">{label}</p>
      <div className="mt-2 space-y-1">
        <p className="text-orange-500">Correlated incident: {values.correlated ?? 0}</p>
        <p className="text-rose-600">Incident: {values.incidents ?? 0}</p>
        <p className="text-indigo-600">Noise: {values.noise ?? 0}</p>
      </div>
    </div>
  );
}

export default function ClassificationTrendChart({ data }) {
  const total = data.reduce((sum, item) => sum + item.noise + item.incidents + item.correlated, 0);

  return (
    <Card className="p-5">
      <div>
        <h3 className="text-lg font-semibold text-slate-950">Classification trend</h3>
        <p className="text-sm text-slate-500">Cumulative decisions as alerts are classified.</p>
      </div>

      {total > 0 ? (
        <div className="mt-5 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ left: -18, right: 16, top: 10, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="label"
                interval="preserveStartEnd"
                minTickGap={24}
                tick={{ fill: '#64748b', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                angle={data.length > 10 ? -25 : 0}
                textAnchor={data.length > 10 ? 'end' : 'middle'}
                height={data.length > 10 ? 48 : 30}
              />
              <YAxis allowDecimals={false} tick={{ fill: '#64748b', fontSize: 12 }} tickLine={false} axisLine={false} />
              <Tooltip content={<TrendTooltip />} />
              <Legend iconType="circle" />
              <Line type="monotone" dataKey="correlated" name="Correlated Incident" stroke="#f59e0b" strokeWidth={3} />
              <Line type="monotone" dataKey="incidents" name="Incident" stroke="#f43f5e" strokeWidth={3} />
              <Line type="monotone" dataKey="noise" name="Noise" stroke="#6366f1" strokeWidth={3} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-5 flex h-72 items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-500">
          Classification trend appears after alerts are classified.
        </div>
      )}
    </Card>
  );
}
