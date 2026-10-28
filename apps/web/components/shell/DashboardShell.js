import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api, clientWorkspace, setToken } from '../../lib/api';
import { Logo, Skeleton, cx } from '../ui';
import { useToast } from '../ui/toast';
import {
  IconBuilding, IconBot, IconChart, IconDocs, IconGlobe, IconInbox, IconKey, IconLogout, IconMail, IconOverview, IconPlus, IconSidebar, IconTicket, IconX
} from '../ui/icons';

// Signed-in shell for both audiences. It confirms the session before
// rendering anything, and sends the visitor to the right sign-in page when
// the session is missing or expired — so a client never sees a staff frame
// (or the reverse).
//   client — one customer company, /dashboard/*  (client session)
//   staff  — KGT platform staff, /admin/*        (operator session)
const AUDIENCES = {
  client: {
    tokenKind: 'client',
    loginPath: '/login',
    label: 'Workspace',
    me: () => api.clientMe().then((r) => ({ name: r.user.name || r.user.email, email: r.user.email, tenant: r.tenant })),
    nav: [
      { href: '/dashboard', label: 'Overview', icon: IconOverview },
      { href: '/dashboard/documents', label: 'Documents', icon: IconDocs },
      { href: '/dashboard/bots', label: 'Test bots', icon: IconBot },
      { href: '/dashboard/keys', label: 'API keys', icon: IconKey },
      { href: '/dashboard/tickets', label: 'Tickets', icon: IconTicket },
      { href: '/dashboard/leads', label: 'Leads & Summaries', icon: IconInbox },
      { href: '/dashboard/usage', label: 'Usage', icon: IconChart },
      { href: '/dashboard/smtp', label: 'Email settings', icon: IconMail }
    ]
  },
  staff: {
    tokenKind: 'operator',
    loginPath: '/admin/login',
    label: 'Staff console',
    me: () => api.staffMe().then((r) => ({ name: r.operator.name, email: r.operator.email })),
    nav: [
      { href: '/admin', label: 'Companies', icon: IconBuilding, match: (p) => p === '/admin' || (p.startsWith('/admin/tenants/') && p !== '/admin/tenants/new') },
      { href: '/admin/tenants/new', label: 'New company', icon: IconPlus },
      { href: '/register', label: 'Public signup', icon: IconGlobe, external: true }
    ]
  }
};

// What pages inside the shell read: the session and (for clients) the
// workspace API bound to their own tenant.
const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

const COLLAPSE_KEY = 'kgtSidebarCollapsed';

export default function DashboardShell({ audience, children }) {
  const config = AUDIENCES[audience];
  const router = useRouter();
  const toast = useToast();
  const [session, setSession] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* storage blocked */ }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { window.localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* storage blocked */ }
      return !c;
    });
  };

  useEffect(() => {
    let alive = true;
    config.me()
      .then((s) => { if (alive) setSession(s); })
      .catch((err) => {
        // Only a rejected session signs the user out. A network failure or
        // server error (the API restarting) keeps the token: reloading works.
        if (err.status !== 401 && err.status !== 403) {
          toast.error(`${err.message} Reload the page to retry.`);
          return;
        }
        if (err.status === 403) toast.error(err.message);
        setToken(config.tokenKind, null);
        router.replace(`${config.loginPath}?next=${encodeURIComponent(router.asPath)}`);
      });
    return () => { alive = false; };
  }, [audience]);

  useEffect(() => { setDrawerOpen(false); }, [router.asPath]);

  const ws = useMemo(() => (audience === 'client' ? clientWorkspace() : null), [audience]);
  const value = useMemo(() => (session ? { ...session, audience, ws } : null), [session, audience, ws]);

  const logout = () => {
    setToken(config.tokenKind, null);
    router.push(config.loginPath);
  };

  const path = router.asPath.split('?')[0];
  const isActive = (item) => (item.match ? item.match(path) : path === item.href);

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 px-2" aria-label={config.label}>
      {config.nav.map((item) => {
        const active = !item.external && isActive(item);
        const Icon = item.icon;
        return (
          <Link key={item.href} href={item.href} title={collapsed ? item.label : undefined}
            className={cx('group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13.5px] font-medium transition',
              active ? 'bg-white/[0.07] text-fg' : 'text-fg-3 hover:bg-white/[0.04] hover:text-fg-2')}
            aria-current={active ? 'page' : undefined}>
            {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-brand-400" />}
            <Icon className={cx('h-[18px] w-[18px] shrink-0', active && 'text-brand-300')} />
            <span className={cx('truncate', collapsed && 'lg:hidden')}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );

  const footer = session && (
    <div className="border-t border-white/[0.06] p-2">
      <div className={cx('flex items-center gap-2.5 rounded-lg px-2 py-2', collapsed && 'lg:justify-center lg:px-0')}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-400/30 to-green-400/30 text-xs font-semibold text-fg">
          {(session.name || '?').slice(0, 1).toUpperCase()}
        </span>
        <div className={cx('min-w-0 flex-1', collapsed && 'lg:hidden')}>
          <p className="truncate text-[13px] font-medium text-fg">{session.name}</p>
          <p className="truncate text-[11.5px] text-fg-3">{session.email}</p>
        </div>
        <button type="button" onClick={logout} className={cx('rounded-md p-1.5 text-fg-3 hover:bg-white/[0.06] hover:text-fg', collapsed && 'lg:hidden')}
          aria-label="Sign out" title="Sign out">
          <IconLogout className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-obsidian">
      <Head><title>{`${session?.tenant?.name || config.label} — KGT AI Hub`}</title></Head>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/[0.06] bg-obsidian/80 px-4 backdrop-blur-xl lg:hidden">
        <Logo />
        <button type="button" onClick={() => setDrawerOpen(true)} className="rounded-lg p-2 text-fg-2 hover:bg-white/[0.06]" aria-label="Open menu">
          <IconSidebar className="h-5 w-5" />
        </button>
      </header>

      {drawerOpen && <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}

      <aside className={cx(
        'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-white/[0.06] bg-panel/95 backdrop-blur-xl transition-[transform,width] duration-200',
        drawerOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        collapsed ? 'lg:w-[68px]' : 'lg:w-60'
      )}>
        <div className={cx('flex h-14 items-center justify-between px-4', collapsed && 'lg:justify-center lg:px-0')}>
          <Link href={config.nav[0].href} aria-label="KGT AI Hub home"><Logo className={collapsed ? 'lg:[&>span]:hidden' : ''} /></Link>
          <button type="button" onClick={() => setDrawerOpen(false)} className="rounded-lg p-1.5 text-fg-3 hover:text-fg lg:hidden" aria-label="Close menu">
            <IconX className="h-5 w-5" />
          </button>
        </div>
        <div className={cx('px-4 pb-3', collapsed && 'lg:hidden')}>
          <p className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-fg-3">{config.label}</p>
          {session?.tenant && <p className="mt-0.5 truncate text-sm font-medium text-fg">{session.tenant.name}</p>}
        </div>
        {nav}
        <button type="button" onClick={toggleCollapsed}
          className="mx-2 mb-2 hidden h-8 items-center gap-3 rounded-lg px-2.5 text-[12.5px] text-fg-3 hover:bg-white/[0.04] hover:text-fg-2 lg:flex"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <IconSidebar className="h-4 w-4 shrink-0" />
          <span className={cx(collapsed && 'hidden')}>Collapse</span>
        </button>
        {footer}
      </aside>

      <main className={cx('transition-[padding] duration-200', collapsed ? 'lg:pl-[68px]' : 'lg:pl-60')}>
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          {value ? (
            <SessionContext.Provider value={value}>
              <div key={path} className="animate-fade-up">{children}</div>
            </SessionContext.Provider>
          ) : (
            <div className="space-y-4" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-4 w-96 max-w-full" />
              <div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
              <Skeleton className="h-64" />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export const clientLayout = (page) => <DashboardShell audience="client">{page}</DashboardShell>;
export const staffLayout = (page) => <DashboardShell audience="staff">{page}</DashboardShell>;
