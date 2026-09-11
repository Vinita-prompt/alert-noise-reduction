import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import Card from '../common/Card.jsx';

const emptyState = (
  <div className="flex h-64 items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-500">
    Classification mix appears after alerts are classified.
  </div>
);

function DecisionTooltip({ active, payload }) {
  if (!active || !payload?.length) {
    return null;
  }

  const item = payload[0]?.payload;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-xl">
      <p className="font-semibold text-slate-950">{item.name}</p>
      <p className="mt-1 text-slate-600">{item.value.toLocaleString()} alerts</p>
    </div>
  );
}

export default function DecisionMixChart({ data }) {
  const visibleData = data.filter((item) => item.value > 0);
  const total = visibleData.reduce((sum, item) => sum + item.value, 0);

  return (
    <Card className="p-5">
      <div>
        <h3 className="text-lg font-semibold text-slate-950">Noise vs Incident</h3>
        <p className="text-sm text-slate-500">Current decision mix for stored alerts.</p>
      </div>

      {total > 0 ? (
        <div className="mt-5 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={visibleData}
                dataKey="value"
                innerRadius={68}
                nameKey="name"
                outerRadius={106}
                paddingAngle={4}
              >
                {visibleData.map((item) => (
                  <Cell key={item.name} fill={item.color} />
                ))}
              </Pie>
              <Tooltip content={<DecisionTooltip />} />
              <Legend iconType="circle" />
            </PieChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-5">{emptyState}</div>
      )}
    </Card>
  );
}
