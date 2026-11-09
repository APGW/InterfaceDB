import { ArrowDownUp, Search, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Chart, timeAxis, valueAxis, zoom } from '../components/Charts'
import { PhasorDiagram } from '../components/PhasorDiagram'
import { defaultRange, FilterPanel, type DateRange } from '../components/Filters'
import { Badge, Card, CardContent, CardHeader, Dialog, EmptyState, ErrorState, LoadingState, Pagination, Select } from '../components/ui'
import { useAsync } from '../hooks/useAsync'
import { eventLabel, formatDateTime, formatDuration, formatNumber } from '../lib/utils'
import { api } from '../services/api'
import { useApp } from '../state/AppContext'
import type { EventType, PQEvent } from '../types/power-quality'

export default function EventsPage() {
  const { meters } = useApp()
  const [searchParams] = useSearchParams()
  const [meterId, setMeterId] = useState('')
  const [eventType, setEventType] = useState<EventType | ''>('')
  const [channelId, setChannelId] = useState(0)
  const [range, setRange] = useState<DateRange>(() => defaultRange(24))
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<'timestamp' | 'duration'>('timestamp')
  const [selected, setSelected] = useState<PQEvent | null>(null)
  const channels = useAsync(() => meterId ? api.getChannels(meterId) : Promise.resolve([]), [meterId])
  const events = useAsync(() => api.getEvents({ meter_id: meterId || undefined, event_type: eventType, channel_id: channelId || undefined, ...range, limit: 200 }), [meterId, eventType, channelId, range.from, range.to])
  useEffect(() => { const id = Number(searchParams.get('event')); if (id && events.data) { const item = events.data.items.find(e => e.event_id === id); if (item) setSelected(item); else api.getEvent(id).then(setSelected).catch(() => undefined) } }, [events.data, searchParams])
  const sorted = useMemo(() => [...(events.data?.items ?? [])].sort((a, b) => sort === 'timestamp' ? b.timestamp.localeCompare(a.timestamp) : b.duration_ms - a.duration_ms), [events.data, sort])
  const visible = sorted.slice(page * 10, page * 10 + 10)
  if (events.loading && !events.data) return <LoadingState label="PQ-Ereignisse werden geladen …" />
  if (events.error) return <ErrorState message={events.error} />
  return <div><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm text-slate-500">Erkannte Spannungsereignisse</p><p className="mt-1 text-xs text-slate-400">Dip · Swell · Interruption · RVC · Transienten · {events.data?.total ?? 0} Ereignisse im Filter</p></div><Badge tone="success">RVC und Transienten aktiv</Badge></div>
    <FilterPanel range={range} onRange={value => { setRange(value); setPage(0) }} onReset={() => { setMeterId(''); setEventType(''); setChannelId(0); setRange(defaultRange(24)); setPage(0) }}>
      <label className="min-w-[175px] flex-1"><span className="label">Messgerät</span><Select value={meterId} onChange={e => { setMeterId(e.target.value); setChannelId(0) }}><option value="">Alle Messgeräte</option>{meters.map(m => <option key={m.meter_id}>{m.meter_id}</option>)}</Select></label>
      <label className="min-w-[190px] flex-1"><span className="label">Ereignistyp</span><Select value={eventType} onChange={e => setEventType(e.target.value as EventType | '')}><option value="">Alle Störungstypen</option>{(['VOLTAGE_DIP', 'VOLTAGE_SWELL', 'VOLTAGE_INTERRUPTION', 'RAPID_VOLTAGE_CHANGE', 'VOLTAGE_TRANSIENT'] as EventType[]).map(type => <option key={type} value={type}>{eventLabel[type]}</option>)}</Select></label>
      <label className="min-w-[150px] flex-1"><span className="label">Kanal</span><Select value={channelId} disabled={!meterId} onChange={e => setChannelId(Number(e.target.value))}><option value={0}>Alle Kanäle</option>{channels.data?.map(c => <option key={c.channel_id} value={c.channel_id}>{c.channel_type}</option>)}</Select></label>
    </FilterPanel>
    <Card><CardHeader title="Ereignishistorie" description="Zusammengesetzt aus pq_events, sample_grid_triggered_events und konkreter Ereignistabelle" action={<button className="flex items-center gap-2 text-xs font-medium text-slate-500" onClick={() => setSort(sort === 'timestamp' ? 'duration' : 'timestamp')}><ArrowDownUp className="h-3.5 w-3.5" />Sortierung: {sort === 'timestamp' ? 'Neueste zuerst' : 'Längste Dauer'}</button>} /><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Event-ID</th><th>Zeitstempel</th><th>Typ / Quelle</th><th>Gerät · Kanal</th><th>Grenze → Messwert</th><th>Dauer</th><th>Erkennungsgrund</th></tr></thead><tbody>{visible.map(event => <tr key={event.event_id} className="cursor-pointer" onClick={() => setSelected(event)}><td className="mono font-semibold">#{event.event_id}</td><td className="mono">{formatDateTime(event.timestamp)}</td><td><Badge tone={eventTone(event.event_type)}>{eventLabel[event.event_type]}</Badge><div className="mt-1 text-[11px] text-slate-400">{event.event_source}</div></td><td><span className="font-medium">{event.meter_id}</span><div className="text-xs text-slate-400">Kanal {event.channel_id} · Phase {event.phase}</div></td><td className="mono">{formatEventMagnitude(event)}</td><td className="mono">{formatDuration(event.duration_ms)}</td><td className="max-w-[220px] text-xs">{event.flag_cause}</td></tr>)}</tbody></table>{!visible.length && <EmptyState />}</div><div className="px-5"><Pagination page={page} pageSize={10} total={sorted.length} onPage={setPage} /></div></Card>
    <Dialog open={!!selected} onOpenChange={open => !open && setSelected(null)} title={selected ? `${eventLabel[selected.event_type]} · #${selected.event_id}` : 'Ereignisdetail'} description="Gespeichertes Ereignis und zugehöriger Spannungsverlauf" size="xl">{selected && <EventDetail event={selected} />}</Dialog>
  </div>
}

function EventDetail({ event }: { event: PQEvent }) {
  const from = new Date(new Date(event.timestamp).getTime() - 90 * 60_000).toISOString(), to = new Date(new Date(event.timestamp).getTime() + 90 * 60_000).toISOString()
  const measurements = useAsync(() => api.getMeasurements({ meter_id: event.meter_id, channel_id: event.channel_id, level: 'BASIC', from, to, limit: 1000 }), [event.event_id])
  const rows = measurements.data?.items.filter(row => row.level === 'BASIC') ?? []
  return <div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Detail label="Zeitstempel" value={formatDateTime(event.timestamp)} /><Detail label="Ereignisquelle" value={event.event_source} /><Detail label="Kanal / Phase" value={`#${event.channel_id} / ${event.phase}`} /><Detail label="Dauer" value={formatDuration(event.duration_ms)} /><Detail label="Grenze und Messwert" value={formatEventMagnitudeText(event)} /><Detail label="Erkennungsgrund" value={event.flag_cause} /><Detail label="Typspezifischer Wert" value={formatEventSpecific(event)} danger /></div>
    {event.event_type === 'RAPID_VOLTAGE_CHANGE' && <div className="mt-6 max-w-xl"><PhasorDiagram title={`RVC-Zeiger · Phase ${event.phase}`} unit="V" vectors={[{ label: 'Vorher', magnitude: event.steady_state_before_voltage ?? 0, angleDeg: event.phase_angle_before_deg ?? 0, color: '#2296B5' }, { label: 'Nachher', magnitude: event.steady_state_after_voltage ?? 0, angleDeg: event.phase_angle_after_deg ?? 0, color: '#7C3AED', dashed: true }]} /></div>}
    <div className="mt-6"><h3 className="section-title">Spannungsverlauf um das Ereignis</h3><p className="mt-1 text-sm text-slate-500">Der Ereigniszeitpunkt ist als gestrichelte Linie hervorgehoben.</p><div className="mt-3 rounded-xl border border-slate-100 p-3 dark:border-slate-800">{measurements.loading ? <LoadingState /> : rows.length ? <Chart height={320} option={{ xAxis: timeAxis, yAxis: valueAxis('V'), dataZoom: zoom, series: [{ name: 'RMS-Spannung', type: 'line', showSymbol: false, data: rows.map(row => [row.timestamp, row.rms_voltage]), markLine: { symbol: ['none', 'none'], lineStyle: { color: '#EF4444', width: 2 }, label: { formatter: 'Ereigniszeitpunkt' }, data: [{ xAxis: event.timestamp }] } }] }} /> : <EmptyState title="Keine zugehörigen Messdaten" text="Für diesen Ereigniszeitraum sind keine Basic-Messwerte geladen." />}</div></div>
    <div className="mt-4 flex items-start gap-2 rounded-lg bg-cyan-50 p-3 text-xs text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200"><Search className="h-4 w-4 shrink-0" />Verknüpfung über event_id, channel_id und den gespeicherten Zeitstempel. Es werden keine fehlenden Zwischenwerte ergänzt.</div>
  </div>
}
function Detail({ label, value, danger }: { label: string; value: string; danger?: boolean }) { return <div className="rounded-lg border border-slate-100 p-3 dark:border-slate-800"><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p><p className={`mt-1 break-words font-mono text-sm font-semibold ${danger ? 'text-red-600' : 'text-slate-800 dark:text-slate-200'}`}>{value}</p></div> }
function eventTone(type: EventType): 'danger' | 'warning' | 'info' { return type === 'VOLTAGE_INTERRUPTION' || type === 'VOLTAGE_TRANSIENT' ? 'danger' : type === 'RAPID_VOLTAGE_CHANGE' ? 'info' : 'warning' }
function formatEventMagnitudeText(event: PQEvent) { return event.event_type === 'VOLTAGE_TRANSIENT' ? `${formatNumber(event.threshold_value, 0)} V → ${formatNumber(event.actual_extreme_value, 0)} V` : event.event_type === 'RAPID_VOLTAGE_CHANGE' ? `${formatNumber(event.threshold_value, 2)} % → ${formatNumber(event.actual_extreme_value, 2)} %` : `${formatNumber(event.threshold_value, 2)} p.u. → ${formatNumber(event.actual_extreme_value, 2)} p.u.` }
function formatEventMagnitude(event: PQEvent) { const [before, after] = formatEventMagnitudeText(event).split(' → '); return <>{before} → <span className="font-semibold text-red-600">{after}</span></> }
function formatEventSpecific(event: PQEvent) {
  if (event.event_type === 'VOLTAGE_DIP') return `${formatNumber(event.dip_residual_voltage ?? 0)} V Residualspannung`
  if (event.event_type === 'VOLTAGE_SWELL') return `${formatNumber(event.swell_peak_voltage ?? 0)} V Spitzenwert`
  if (event.event_type === 'VOLTAGE_INTERRUPTION') return `${formatNumber(event.interruption_voltage ?? 0)} V Unterbrechungsspannung`
  if (event.event_type === 'RAPID_VOLTAGE_CHANGE') return `${formatNumber(event.voltage_change_percent ?? 0, 2)} % · ${formatNumber(event.steady_state_before_voltage ?? 0, 1)} V → ${formatNumber(event.steady_state_after_voltage ?? 0, 1)} V`
  return `${formatNumber(event.transient_peak_voltage ?? 0, 0)} V · ${formatNumber(event.transient_rise_time_us ?? 0, 0)} µs Anstieg · ${formatNumber(event.transient_duration_us ?? 0, 0)} µs Dauer · ${event.transient_polarity === 'NEGATIVE' ? 'negativ' : 'positiv'}`
}
