import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getCurrentUser, loginCurrentUser, logoutCurrentUser } from '../services/api.js';

const AuthContext = createContext(null);

const normalizeRole = (role) => String(role || '').trim().toLowerCase().replaceAll(' ', '_');

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setSession(await getCurrentUser()); setNotice(''); }
    catch (error) { setSession(null); setNotice(error?.code === 'AUTH_SESSION_EXPIRED' ? 'Session expired.' : ''); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const value = useMemo(() => {
    const roles = (session?.user?.roles || []).map(normalizeRole);
    return {
      session,
      user: session?.user || null,
      loading,
      authenticated: Boolean(session?.authenticated),
      notice,
      isAdmin: roles.includes('admin') || roles.includes('administrator'),
      canOperate: roles.some((role) => ['operator', 'incident_manager', 'admin', 'administrator'].includes(role)),
      async login(credentials) { const next = await loginCurrentUser(credentials); setSession(next); setNotice(''); return next; },
      async logout() { await logoutCurrentUser(); setSession(null); setNotice(''); },
      refresh,
    };
  }, [loading, notice, refresh, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}

export function RequireAuth({ children }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.loading) return <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] text-sm font-semibold text-slate-500">Loading CommandCenter…</div>;
  return auth.authenticated ? children : <Navigate to="/login" replace state={{ from: location, message: auth.notice }} />;
}

export function RequireAdmin({ children }) {
  const auth = useAuth();
  return auth.isAdmin ? children : <Navigate to="/overview" replace />;
}
