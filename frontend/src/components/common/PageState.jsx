import Card from './Card.jsx';

const variants = {
  default: 'border-slate-200 bg-white text-slate-600',
  loading: 'border-cyan-200 bg-cyan-50 text-cyan-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  error: 'border-rose-200 bg-rose-50 text-rose-800',
};

export default function PageState({ title, message, variant = 'default' }) {
  return (
    <Card className={`p-5 ${variants[variant] || variants.default}`}>
      <p className="font-semibold">{title}</p>
      {message ? <p className="mt-1 text-sm opacity-90">{message}</p> : null}
    </Card>
  );
}
