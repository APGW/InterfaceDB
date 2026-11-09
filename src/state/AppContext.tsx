import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, DEMO_MODE } from '../services/api'
import type { Meter } from '../types/power-quality'

interface AppState {
  meters: Meter[]
  globalMeterId: string
  setGlobalMeterId: (id: string) => void
  loadingMeters: boolean
  demoMode: boolean
  darkMode: boolean
  setDarkMode: (value: boolean) => void
}
const AppContext = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [meters, setMeters] = useState<Meter[]>([])
  const [loadingMeters, setLoading] = useState(true)
  const [globalMeterId, setGlobalMeterIdState] = useState(() => sessionStorage.getItem('pq-meter') ?? '')
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('pq-theme') === 'dark')
  useEffect(() => { api.getMeters().then(items => { setMeters(items); if (!globalMeterId && items[0]) setGlobalMeterIdState(items[0].meter_id) }).finally(() => setLoading(false)) }, [])
  useEffect(() => { document.documentElement.classList.toggle('dark', darkMode); localStorage.setItem('pq-theme', darkMode ? 'dark' : 'light') }, [darkMode])
  const setGlobalMeterId = (id: string) => { setGlobalMeterIdState(id); sessionStorage.setItem('pq-meter', id) }
  const value = useMemo(() => ({ meters, globalMeterId, setGlobalMeterId, loadingMeters, demoMode: DEMO_MODE, darkMode, setDarkMode }), [meters, globalMeterId, loadingMeters, darkMode])
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
export function useApp() { const value = useContext(AppContext); if (!value) throw new Error('AppContext fehlt'); return value }
