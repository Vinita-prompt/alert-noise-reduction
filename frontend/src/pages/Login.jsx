import { Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Login() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState(() => localStorage.getItem('commandcenter.rememberedEmail') || '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(Boolean(localStorage.getItem('commandcenter.rememberedEmail')));
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(() => location.state?.message || '');

  useEffect(() => { document.title = 'Sign in · CommandCenter'; }, []);
  if (!auth.loading && auth.authenticated) return <Navigate to="/overview" replace />;

  async function submit(event) {
    event.preventDefault(); setSubmitting(true); setError(''); setNotice('');
    try {
      await auth.login({ email, password });
      if (remember) localStorage.setItem('commandcenter.rememberedEmail', email.trim());
      else localStorage.removeItem('commandcenter.rememberedEmail');
      navigate('/overview', { replace: true });
    } catch (requestError) { setError(requestError.message); }
    finally { setSubmitting(false); }
  }

  return <main className="min-h-screen bg-[#F8FAFC] px-5 py-10 text-[#172033]">
    <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md items-center">
      <section className="w-full rounded-2xl border border-[#E2E8F0] bg-white p-7 shadow-sm sm:p-9">
        <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#1F2937] text-white"><ShieldCheck className="h-5 w-5" /></span><div><h1 className="text-xl font-bold tracking-tight">CommandCenter</h1><p className="text-xs text-[#64748B]">Alert Noise Reduction Platform</p></div></div>
        <div className="mt-8"><h2 className="text-2xl font-semibold">Welcome back</h2><p className="mt-2 text-sm text-[#64748B]">Sign in to continue to the operations workspace.</p></div>
        <form className="mt-7 space-y-4" onSubmit={submit}>
          <label className="cc-field">Work email<input autoComplete="email" className="cc-input" name="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className="cc-field">Password<span className="relative mt-2 block"><input autoComplete="current-password" className="cc-input mt-0 pr-11" name="password" required type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} /><button aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-500" type="button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></span></label>
          <div className="flex items-center justify-between gap-3 text-xs"><label className="flex items-center gap-2 text-slate-600"><input checked={remember} className="accent-[#0F766E]" type="checkbox" onChange={(event) => setRemember(event.target.checked)} />Remember my email</label><button className="font-semibold text-[#0F766E]" type="button" onClick={() => setNotice('Password recovery is not available yet. Use the password created during signup.')}>Forgot password?</button></div>
          {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div> : null}
          {notice ? <div role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">{notice}</div> : null}
          <button className="cc-button-primary w-full justify-center" disabled={submitting} type="submit"><LockKeyhole className="h-4 w-4" />{submitting ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-600">First time here? <Link className="font-semibold text-[#0F766E]" to="/signup">Create an account</Link></p>
      </section>
    </div>
  </main>;
}
