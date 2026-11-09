import { ArrowRight, Cpu, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Card, CardHeader, EmptyState, ErrorState, Input, LoadingState } from '../components/ui'
import { useAsync } from '../hooks/useAsync'
import { formatDate } from '../lib/utils'
import { api } from '../services/api'

export default function MetersPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const { data, loading, error } = useAsync(() => api.getMeters(), [])
  const rows = useMemo(() => (data ?? []).filter(m => `${m.meter_id} ${m.firmware_version} ${m.active_class}`.toLowerCase().includes(search.toLowerCase())), [data, search])
  if (loading) return <LoadingState label="Messgeräte werden geladen …" />
  if (error) return <ErrorState message={error} />
  return <div><div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="text-sm text-slate-500">Registrierte Messgeräte und technische Stammdaten</p><p className="mt-1 text-xs text-slate-400">{data?.length ?? 0} Geräte im System</p></div><div className="relative w-full sm:w-72"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><Input className="pl-9" placeholder="Gerät oder Firmware suchen …" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
    <Card><CardHeader title="Geräteübersicht" description="Datenquelle: meters" /><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Geräte-ID</th><th>Firmware-Version</th><th>Messklasse</th><th>Registriert am</th><th /></tr></thead><tbody>{rows.map(meter => <tr key={meter.meter_id} className="cursor-pointer" onClick={() => navigate(`/messgeraete/${meter.meter_id}`)}><td><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-cyan-50 text-brand dark:bg-cyan-950"><Cpu className="h-4 w-4" /></div><span className="font-semibold text-slate-900 dark:text-white">{meter.meter_id}</span></div></td><td className="mono">v{meter.firmware_version}</td><td><Badge tone={meter.active_class === 'CLASS_A' ? 'success' : 'info'}>{meter.active_class.replace('_', ' ')}</Badge></td><td>{formatDate(meter.created_at)}</td><td className="text-right"><ArrowRight className="ml-auto h-4 w-4 text-slate-400" /></td></tr>)}</tbody></table>{!rows.length && <EmptyState title="Kein Messgerät gefunden" text="Passen Sie den Suchbegriff an." />}</div></Card>
  </div>
}
