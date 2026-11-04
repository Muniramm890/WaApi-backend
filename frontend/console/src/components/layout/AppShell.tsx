import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useDialog } from '../../contexts/DialogContext';
import { can } from '../../lib/perm';
import { title } from '../../lib/format';
import { Icon } from '../ui';

export function AppShell() {
  const { user, logout } = useAuth(); const { theme, toggle } = useTheme(); const dialog = useDialog();
  const [open, setOpen] = useState(false); const loc = useLocation();
  const role = user?.role;
  const items: { to: string; label: string; icon: string; show: boolean; sec?: string }[] = [
    { to: '/', label: 'Dashboard', icon: 'home', show: true },
    { to: '/tenants', label: 'Customers', icon: 'users', show: true, sec: 'Manage' },
    { to: '/plans', label: 'Plans', icon: 'layers', show: true },
    { to: '/billing', label: 'Billing', icon: 'receipt', show: can.billing(role) },
    { to: '/health', label: 'WhatsApp health', icon: 'activity', show: true, sec: 'Operations' },
    { to: '/messages', label: 'Messages', icon: 'message', show: true },
    { to: '/webhooks', label: 'Webhooks', icon: 'hook', show: true },
    { to: '/audit', label: 'Audit log', icon: 'shield', show: true },
    { to: '/settings', label: 'Settings', icon: 'sliders', show: true, sec: 'Platform' },
    { to: '/staff', label: 'Staff', icon: 'key', show: can.admin(role) },
  ];
  const doLogout = async () => { if (await dialog.confirm({ title: 'Sign out', message: 'Do you want to sign out of the Control Center?', confirmText: 'Sign out' })) await logout(); };
  return (
    <div className="app">
      <aside className={'sidebar' + (open ? ' open' : '')}>
        <div className="brand"><img src="/favicon.svg" alt="" /><div>WA Platform<small>Control Center</small></div></div>
        <nav className="nav" onClick={() => setOpen(false)}>
          {items.filter((i) => i.show).map((i) => (
            <div key={i.to}>
              {i.sec && <div className="sec">{i.sec}</div>}
              <NavLink to={i.to} end={i.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}><Icon name={i.icon} />{i.label}</NavLink>
            </div>
          ))}
        </nav>
        <div className="nav" style={{ flex: 'none', borderTop: '1px solid var(--border)' }} onClick={() => setOpen(false)}>
          <NavLink to="/profile" className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="user" /><span style={{ minWidth: 0 }}><b style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.name}</b><small style={{ opacity: .75 }}>{title(user?.role)}</small></span></NavLink>
        </div>
      </aside>
      <div className={'scrim' + (open ? ' open' : '')} onClick={() => setOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button className="icon-btn only-mobile" onClick={() => setOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
          <div className="grow muted">{loc.pathname === '/' ? 'Overview' : ''}</div>
          <button className="icon-btn" onClick={toggle} aria-label="Toggle theme" title="Toggle theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <button className="icon-btn" onClick={doLogout} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
