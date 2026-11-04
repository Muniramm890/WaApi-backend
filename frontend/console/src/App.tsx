import { Navigate, Route, Routes, useLocation, Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './contexts/AuthContext';
import { AppShell } from './components/layout/AppShell';
import { Loading, PageHeader, Empty } from './components/ui';
import { can } from './lib/perm';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tenants from './pages/Tenants';
import TenantDetail from './pages/TenantDetail';
import Plans from './pages/Plans';
import Billing from './pages/Billing';
import Health from './pages/Health';
import Messages from './pages/Messages';
import Webhooks from './pages/Webhooks';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import Staff from './pages/Staff';
import Profile from './pages/Profile';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth(); const loc = useLocation();
  if (!ready) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}
function Guard({ ok, children }: { ok: (r?: any) => boolean; children: ReactNode }) {
  const { user } = useAuth();
  if (!ok(user?.role)) return <><PageHeader title="Access denied" /><Empty>Your role does not have access to this section.</Empty></>;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="tenants/:id" element={<TenantDetail />} />
        <Route path="plans" element={<Plans />} />
        <Route path="billing" element={<Guard ok={can.billing}><Billing /></Guard>} />
        <Route path="health" element={<Health />} />
        <Route path="messages" element={<Messages />} />
        <Route path="webhooks" element={<Webhooks />} />
        <Route path="audit" element={<Audit />} />
        <Route path="settings" element={<Settings />} />
        <Route path="staff" element={<Guard ok={can.admin}><Staff /></Guard>} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<><PageHeader title="Page not found" /><Empty>This page does not exist. <Link to="/">Back to dashboard</Link></Empty></>} />
      </Route>
    </Routes>
  );
}
