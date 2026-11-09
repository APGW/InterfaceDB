import { Activity, BarChart3, ChevronRight, CircleUserRound, Database, Flag, Gauge, Menu, Moon, RadioTower, Settings2, Sun, X, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useApp } from '../state/AppContext'
import { Badge, Button, Select } from './ui'
import { cn, formatDateTime } from '../lib/utils'

const navItems = [
  { to: '/', label: 'Dashboard', icon: Gauge },
  { to: '/messgeraete', label: 'Messgeräte', icon: Database },
  { to: '/messdaten', label: 'Messdatenanalyse', icon: BarChart3 },
  { to: '/ereignisse', label: 'PQ-Ereignisse', icon: Zap },
  { to: '/flagging', label: 'Flagging', icon: Flag },
  { to: '/konfiguration', label: 'Konfiguration', icon: Settings2 },
  { to: '/systemstatus', label: 'Systemstatus', icon: RadioTower },
]
const titles: Record<string, string> = { '/': 'Dashboard', '/messgeraete': 'Messgeräte', '/messdaten': 'Messdatenanalyse', '/ereignisse': 'PQ-Ereignisse', '/flagging': 'Flagging & Propagation', '/konfiguration': 'Konfiguration', '/systemstatus': 'Systemstatus' }

export function AppShell() {
  const { meters, globalMeterId, setGlobalMeterId, demoMode, darkMode, setDarkMode } = useApp()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [clock, setClock] = useState(new Date())
  useEffect(() => { const timer = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => setMobileOpen(false), [location.pathname])
  const basePath = navItems.find(item => item.to !== '/' && location.pathname.startsWith(item.to))?.to ?? '/'
  const title = titles[basePath]

  const sidebar = <aside className="flex h-full w-[252px] flex-col bg-navy text-slate-200">
    <div className="flex h-[76px] items-center gap-3 border-b border-white/10 px-5"><div className="grid h-10 w-10 place-items-center rounded-xl bg-brand text-white shadow-lg shadow-cyan-950/30"><Activity className="h-6 w-6" /></div><div><div className="text-[17px] font-bold tracking-tight text-white">PQM</div><div className="text-[10px] font-semibold uppercase tracking-[.2em] text-cyan-300">Power Quality</div></div></div>
    <div className="px-4 pb-2 pt-5 text-[10px] font-semibold uppercase tracking-[.18em] text-slate-500">Überwachung</div>
    <nav className="flex-1 space-y-1 px-3">{navItems.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cn('group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition', isActive ? 'bg-brand text-white shadow-md shadow-cyan-950/20' : 'text-slate-300 hover:bg-white/7 hover:text-white')}><Icon className="h-[18px] w-[18px]" />{label}</NavLink>)}</nav>
    <div className="m-3 mt-0 rounded-xl border border-white/10 bg-white/5 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-white"><RadioTower className="h-4 w-4 text-cyan-300" />Systemverbindung</div><div className="mt-2 flex items-center justify-between text-[11px] text-slate-400"><span>{demoMode ? 'Demo-Service' : 'REST API'}</span><span className="flex items-center gap-1.5 text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Bereit</span></div></div>
  </aside>

  return <div className="min-h-screen bg-canvas dark:bg-[#0b1220]">
    <div className="fixed inset-y-0 left-0 z-40 hidden lg:block">{sidebar}</div>
    {mobileOpen && <div className="fixed inset-0 z-50 lg:hidden"><button className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileOpen(false)} aria-label="Navigation schließen" /><div className="relative h-full w-[252px]">{sidebar}<button className="absolute right-3 top-3 rounded p-2 text-white" onClick={() => setMobileOpen(false)}><X /></button></div></div>}
    <div className="lg:pl-[252px]">
      <header className="sticky top-0 z-30 flex min-h-[76px] items-center gap-4 border-b border-slate-200/80 bg-white/95 px-4 backdrop-blur md:px-7 dark:border-slate-800 dark:bg-slate-900/95">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)}><Menu className="h-5 w-5" /></Button>
        <div className="min-w-0 flex-1"><div className="mb-1 flex items-center gap-1 text-xs text-slate-400"><span>PQM</span><ChevronRight className="h-3 w-3" /><span>{title}</span></div><h1 className="truncate text-xl font-semibold tracking-tight text-slate-900 dark:text-white">{title}</h1></div>
        <div className="hidden text-right xl:block"><div className="mono font-semibold text-slate-700 dark:text-slate-200">{formatDateTime(clock)}</div><div className="text-[10px] uppercase tracking-wider text-slate-400">Europe/Berlin</div></div>
        {demoMode && <Badge tone="warning" className="hidden sm:inline-flex">Demo-Daten</Badge>}
        <div className="hidden w-48 md:block"><Select aria-label="Globales Messgerät" value={globalMeterId} onChange={e => setGlobalMeterId(e.target.value)}>{meters.map(m => <option key={m.meter_id} value={m.meter_id}>{m.meter_id}</option>)}</Select></div>
        <Button variant="ghost" size="icon" onClick={() => setDarkMode(!darkMode)} aria-label="Farbschema wechseln">{darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</Button>
        <div className="hidden h-9 w-px bg-slate-200 sm:block dark:bg-slate-700" /><button className="hidden items-center gap-2 sm:flex"><div className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800"><CircleUserRound className="h-5 w-5" /></div><div className="hidden text-left 2xl:block"><div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Operator</div><div className="text-[10px] text-slate-400">Authentifizierung geplant</div></div></button>
      </header>
      {demoMode && <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">DEMO_MODE aktiv · Alle angezeigten Messwerte sind ausdrücklich gekennzeichnete Beispieldaten.</div>}
      <main className="mx-auto max-w-[1700px] p-4 md:p-7"><Outlet /></main>
    </div>
  </div>
}
