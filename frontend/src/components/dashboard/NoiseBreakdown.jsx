import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import Card from '../common/Card.jsx';

export default function NoiseBreakdown({ data }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <Card className="p-5">
      <div>
        <h3 className="text-lg font-semibold text-slate-950">Noise type breakdown</h3>
        <p className="text-sm text-slate-500">Classification mix for suppressed or grouped alerts.</p>
      </div>

      {total > 0 ? (
        <div className="mt-5 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={3}>
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: '1px solid #e2e8f0',
                  boxShadow: '0 12px 30px rgba(15, 23, 42, 0.12)',
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-5 flex h-64 items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-500">
          No noise alerts available.
        </div>
      )}

      <div className="mt-2 space-y-3">
        {data.map((item) => (
          <div key={item.name} className="flex items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-2 text-slate-600">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              {item.name}
            </div>
            <div className="font-semibold text-slate-950">
              {total > 0 ? Math.round((item.value / total) * 100) : 0}%
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
