import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { LoadingState } from './components/ui'

const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const MetersPage = lazy(() => import('./pages/MetersPage'))
const MeterDetailPage = lazy(() => import('./pages/MeterDetailPage'))
const MeasurementsPage = lazy(() => import('./pages/MeasurementsPage'))
const EventsPage = lazy(() => import('./pages/EventsPage'))
const FlaggingPage = lazy(() => import('./pages/FlaggingPage'))
const ConfigurationPage = lazy(() => import('./pages/ConfigurationPage'))
const SystemStatusPage = lazy(() => import('./pages/SystemStatusPage'))

export default function App() {
  return <Suspense fallback={<LoadingState label="Ansicht wird geladen …" />}><Routes><Route element={<AppShell />}><Route index element={<DashboardPage />} /><Route path="messgeraete" element={<MetersPage />} /><Route path="messgeraete/:meterId" element={<MeterDetailPage />} /><Route path="messdaten" element={<MeasurementsPage />} /><Route path="ereignisse" element={<EventsPage />} /><Route path="flagging" element={<FlaggingPage />} /><Route path="konfiguration" element={<ConfigurationPage />} /><Route path="systemstatus" element={<SystemStatusPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Route></Routes></Suspense>
}
