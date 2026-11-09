import { AlertTriangle, Download, Flag, Info, Link2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { EChartsOption } from 'echarts'
import { Chart, timeAxis, valueAxis, zoom } from '../components/Charts'
import { defaultRange, FilterPanel, type DateRange } from '../components/Filters'
import { Badge, Button, Card, CardContent, CardHeader, Dialog, EmptyState, ErrorState, LoadingState, Pagination, Select } from '../components/ui'
import { useAsync } from '../hooks/useAsync'
import { downloadCsv, eventLabel, formatDateTime, formatNumber, levelLabel } from '../lib/utils'
import { api } from '../services/api'
import { useApp } from '../state/AppContext'
import type { FlagPropagation, Measurement, MeasurementLevel, PQEvent } from '../types/power-quality'

const levels: MeasurementLevel[] = ['BASIC', 'SHORT_TERM', 'TEN_MINUTE', 'TWO_HOUR']
const metrics: Record<MeasurementLevel, { value: string; label: string }[]> = {
  BASIC: [{ value: 'overview', label: 'Spannung, Strom, Frequenz & THDS' }, { value: 'voltage_thds_percent', label: 'Spannungs-THDS' }],
  SHORT_TERM: [{ value: 'aggregated_rms', label: 'Aggregierter RMS-Wert' }],
  TEN_MINUTE: [{ value: 'overview', label: 'RMS & Pst-Flicker' }, { value: 'aggregated_rms', label: 'Aggregierter RMS-Wert' }, { value: 'pst_flicker', label: 'Pst-Flicker' }],
  TWO_HOUR: [{ value: 'overview', label: 'Langzeit-RMS & Plt-Flicker' }, { value: 'long_term_rms', label: 'Langfristiger RMS-Wert' }, { value: 'plt_flicker', label: 'Plt-Flicker' }],
}

export default function MeasurementsPage() {
  const { meters, globalMeterId } = useApp()
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const [meterId, setMeterId] = useState(search.get('meter') || globalMeterId)
  const [channelId, setChannelId] = useState(Number(search.get('channel')) || 0)
  const [level, setLevel] = useState<MeasurementLevel>('BASIC')
  const [metric, setMetric] = useState('overview')
  const [range, setRange] = useState<DateRange>(() => defaultRange(24))
  const [selected, setSelected] = useState<Measurement | null>(null)
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [page, setPage] = useState(0)
  const channelsState = useAsync(() => meterId ? api.getChannels(meterId) : Promise.resolve([]), [meterId])
  useEffect(() => { if (channelsState.data?.length && !channelsState.data.some(c => c.channel_id === channelId)) setChannelId(channelsState.data[0].channel_id) }, [channelsState.data, channelId])
  useEffect(() => { if (!meterId && globalMeterId) setMeterId(globalMeterId) }, [globalMeterId, meterId])
  useEffect(() => { setMetric(metrics[level][0].value); setPage(0) }, [level])
  const result = useAsync(() => channelId ? api.getMeasurements({ meter_id: meterId, channel_id: channelId, level, metric, ...range, limit: 1000 }) : Promise.resolve({ items: [], total: 0, limit: 1000, offset: 0 }), [meterId, channelId, level, metric, range.from, range.to])
  const events = useAsync(() => meterId ? api.getEvents({ meter_id: meterId, channel_id: channelId || undefined, ...range, limit: 100 }) : Promise.resolve({ items: [], total: 0, limit: 100, offset: 0 }), [meterId, channelId, range.from, range.to])
  const flags = useAsync(() => meterId && channelId ? api.getFlags({ meter_id: meterId, channel_id: channelId, target_level: level, ...range }) : Promise.resolve([]), [meterId, channelId, level, range.from, range.to])
  const rows = result.data?.items ?? []
  const flagGroups = useMemo(() => {
    const groups = new Map<string, FlagPropagation[]>()
    ;(flags.data ?? []).forEach(flag => {
      const key = measurementFlagKey(flag.channel_id, flag.target_level, flag.value_timestamp)
      groups.set(key, [...(groups.get(key) ?? []), flag])
    })
    return groups
  }, [flags.data])
  const flagsForRow = (row: Measurement) => flagGroups.get(measurementFlagKey(row.channel_id, row.level, row.timestamp)) ?? []
  const eventById = useMemo(() => new Map((events.data?.items ?? []).map(event => [event.event_id, event])), [events.data])
  const filteredRows = flaggedOnly ? rows.filter(row => row.is_flagged) : rows
  const tableRows = filteredRows.slice(page * 10, page * 10 + 10)
  const selectedFlags = selected ? flagsForRow(selected) : []
  const selectedEvents = selectedFlags.map(flag => eventById.get(flag.source_event_id)).filter((event): event is PQEvent => Boolean(event))
  useEffect(() => setPage(0), [flaggedOnly])

  const lineOption = (key: string, name: string, unit: string): EChartsOption => ({
    xAxis: timeAxis, yAxis: valueAxis(unit), dataZoom: zoom,
    tooltip: { trigger: 'axis', valueFormatter: (value: unknown) => `${formatNumber(Number(value), key === 'frequency' ? 3 : 2)} ${unit}` },
    series: [{ name, type: 'line', showSymbol: false, smooth: false, lineStyle: { width: 1.8 }, areaStyle: { opacity: .05 }, data: rows.map((row, index) => ({ row, index, value: (row as unknown as Record<string, unknown>)[key] })).filter(item => item.value !== null && item.value !== undefined).map(item => [item.row.timestamp, Number(item.value), item.index]), markPoint: { symbolSize: 36, tooltip: { formatter: (raw: unknown) => formatFlagTooltip(raw) }, data: rows.flatMap((row, rowIndex) => {
      const value = (row as unknown as Record<string, unknown>)[key]
      if (!row.is_flagged || value === null || value === undefined) return []
      const relatedFlags = flagsForRow(row)
      return [{ name: 'Geflaggt', coord: [row.timestamp, Number(value)], value: '!', rowIndex, flag: relatedFlags[0], relatedFlagCount: relatedFlags.length, itemStyle: { color: '#DC2626', borderColor: '#FEE2E2', borderWidth: 2 } }]
    }) }, ...(key.includes('voltage') || key.includes('rms') ? { markLine: { symbol: ['none', 'none'], lineStyle: { color: '#F59E0B', type: 'dashed' }, label: { show: false }, data: (events.data?.items ?? []).map(e => ({ xAxis: e.timestamp })) } } : {}) }] as EChartsOption['series'],
  })
  const chartEvents = { click: (params: unknown) => {
    const p = params as { data?: unknown[] | { rowIndex?: number }; dataIndex?: number }
    const index = Array.isArray(p.data) ? Number(p.data[2] ?? p.dataIndex) : Number(p.data?.rowIndex ?? p.dataIndex)
    if (Number.isInteger(index) && rows[index]) setSelected(rows[index])
  } }

  if ((result.loading || channelsState.loading || flags.loading) && !result.data) return <LoadingState label="Messdaten werden geladen …" />
  if (result.error || channelsState.error || flags.error) return <ErrorState message={result.error ?? channelsState.error ?? flags.error ?? 'Unbekannter Fehler'} />

  return <div>
    <div className="mb-5 flex flex-col justify-between gap-3 md:flex-row md:items-end"><div><p className="text-sm text-slate-500">Interaktive Zeitreihenanalyse über vier Aggregationsstufen</p><p className="mt-1 text-xs text-slate-400">Geladener Ausschnitt: {rows.length} von {result.data?.total ?? 0} Werten</p></div><Button variant="secondary" disabled={!rows.length} onClick={() => downloadCsv(`messwerte_${meterId}_${level.toLowerCase()}.csv`, rows as unknown as Record<string, unknown>[])}><Download className="h-4 w-4" />Geladene Daten als CSV</Button></div>
    <FilterPanel range={range} onRange={setRange} onReset={() => { setMeterId(globalMeterId); setLevel('BASIC'); setRange(defaultRange(24)) }}>
      <label className="min-w-[180px] flex-1"><span className="label">Messgerät</span><Select value={meterId} onChange={e => { setMeterId(e.target.value); setChannelId(0) }}>{meters.map(m => <option key={m.meter_id}>{m.meter_id}</option>)}</Select></label>
      <label className="min-w-[180px] flex-1"><span className="label">Messkanal</span><Select value={channelId} onChange={e => setChannelId(Number(e.target.value))}>{channelsState.data?.map(c => <option key={c.channel_id} value={c.channel_id}>{c.channel_type} · {c.channel_name}</option>)}</Select></label>
      <label className="min-w-[200px] flex-1"><span className="label">Messgröße</span><Select value={metric} onChange={e => setMetric(e.target.value)}>{metrics[level].map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></label>
    </FilterPanel>
    <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-2 lg:grid-cols-4 dark:border-slate-700 dark:bg-slate-900">{levels.map(item => <button key={item} onClick={() => setLevel(item)} className={`rounded-lg px-3 py-3 text-left transition ${level === item ? 'bg-brand text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'}`}><div className="text-sm font-semibold">{levelLabel[item].split(' · ')[0]}</div><div className={`mt-0.5 text-[11px] ${level === item ? 'text-cyan-100' : 'text-slate-400'}`}>{levelLabel[item].split(' · ')[1]}</div></button>)}</div>
    {result.loading && <div className="mb-3 h-1 overflow-hidden rounded-full bg-cyan-100"><div className="h-full w-1/2 animate-pulse rounded-full bg-brand" /></div>}
    {!rows.length ? <Card><EmptyState title="Keine Messwerte im Zeitraum" text="Wählen Sie einen anderen Kanal oder erweitern Sie den Zeitraum." /></Card> : <>
      {level === 'BASIC' && metric === 'overview' && <><div className="grid gap-5 xl:grid-cols-2"><MeasurementChart title="RMS-Spannung" description="10/12-Zyklus-Grundintervall" origin="Übergeben · Basic" option={lineOption('rms_voltage', 'RMS-Spannung', 'V')} onEvents={chartEvents} flagged={rows.filter(r => r.is_flagged).length} /><MeasurementChart title="RMS-Strom" description="Eigene Skala für Strom" origin="Übergeben · Basic" option={lineOption('rms_current', 'RMS-Strom', 'A')} onEvents={chartEvents} /><MeasurementChart title="Frequenz" description="Eigene Skala für Frequenz" origin="Übergeben · Basic" option={lineOption('frequency', 'Frequenz', 'Hz')} onEvents={chartEvents} /><MeasurementChart title="Spannungs-THDS" description="Vom Messgerät/DSP geliefert · NULL bleibt Datenlücke" origin="Übergeben · DSP" option={lineOption('voltage_thds_percent', 'Spannungs-THDS', '%')} onEvents={chartEvents} /></div><Card className="mt-5"><CardHeader title="Datenqualität" description="Status im aktuell geladenen Datenausschnitt" /><CardContent><div className="grid grid-cols-2 gap-4 lg:grid-cols-4"><Quality label="Qualitätsklasse" value={rows[0].quality_class.replace('_', ' ')} /><Quality label="Geflaggte Werte" value={String(rows.filter(r => r.is_flagged).length)} warning={rows.some(r => r.is_flagged)} /><Quality label="Flag-Zuordnungen" value={String(flags.data?.length ?? 0)} warning={Boolean(flags.data?.length)} /><Quality label="Messpunkte" value={String(rows.length)} /></div><div className="mt-4 flex gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800"><Info className="h-4 w-4 shrink-0 text-brand" />Die Kennzeichnung wird über den exakten Messwert-Zeitstempel, Kanal und die Aggregationsstufe mit der gespeicherten Flag-Fortpflanzung verknüpft.</div></CardContent></Card></>}
      {level === 'BASIC' && metric === 'voltage_thds_percent' && <MeasurementChart title="Spannungs-THDS" description="Vom Messgerät/DSP geliefert · Einheit Prozent" origin="Übergeben · DSP" option={lineOption('voltage_thds_percent', 'Spannungs-THDS', '%')} onEvents={chartEvents} flagged={rows.filter(r => r.is_flagged).length} />}
      {level === 'SHORT_TERM' && <MeasurementChart title="Aggregierter RMS-Wert" description="Messlücken sind in der Tabelle gekennzeichnet" origin="Übergeben · Short Term" option={lineOption('aggregated_rms', 'Aggregierter RMS', 'V')} onEvents={chartEvents} flagged={rows.filter(r => r.is_flagged).length} />}
      {level === 'TEN_MINUTE' && <div className="grid gap-5 xl:grid-cols-2">{(metric === 'overview' || metric === 'aggregated_rms') && <MeasurementChart title="Aggregierter RMS-Wert" description="10-Minuten-Intervall" origin="Übergeben · Ten Minute" option={lineOption('aggregated_rms', 'RMS', 'V')} onEvents={chartEvents} flagged={rows.filter(r => r.is_flagged).length} />}{(metric === 'overview' || metric === 'pst_flicker') && <MeasurementChart title="Pst-Flicker" description="Kurzzeit-Flickerstärke" origin="Übergeben · Ten Minute" option={lineOption('pst_flicker', 'Pst', 'Pst')} onEvents={chartEvents} />}</div>}
      {level === 'TWO_HOUR' && <div className="grid gap-5 xl:grid-cols-2">{(metric === 'overview' || metric === 'long_term_rms') && <MeasurementChart title="Langfristiger RMS-Wert" description="2-Stunden-Aggregat" origin="Übergeben · Two Hour" option={lineOption('long_term_rms', 'Langzeit-RMS', 'V')} onEvents={chartEvents} flagged={rows.filter(r => r.is_flagged).length} />}{(metric === 'overview' || metric === 'plt_flicker') && <MeasurementChart title="Plt-Flicker" description="Langzeit-Flickerstärke" origin="Übergeben · Two Hour" option={lineOption('plt_flicker', 'Plt', 'Plt')} onEvents={chartEvents} />}</div>}
      <Card className="mt-5"><CardHeader title="Geladene Messwerte" description={`${levelLabel[level]} · sortiert nach Zeitstempel`} action={<Button variant={flaggedOnly ? 'primary' : 'secondary'} size="sm" onClick={() => setFlaggedOnly(value => !value)}><Flag className="h-3.5 w-3.5" />{flaggedOnly ? 'Alle Messwerte' : `Nur geflaggte (${rows.filter(row => row.is_flagged).length})`}</Button>} /><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Zeitstempel</th><th>Kanal</th><th>Messwert(e)</th><th>Qualität</th><th>Flag / Datenqualität</th></tr></thead><tbody>{tableRows.map(row => <tr key={row.timestamp} className="cursor-pointer" onClick={() => setSelected(row)}><td className="mono">{formatDateTime(row.timestamp)}</td><td className="mono">#{row.channel_id}</td><td className="font-mono text-xs">{measurementSummary(row)}</td><td><Badge tone="neutral">{row.quality_class.replace('_', ' ')}</Badge></td><td><FlagStatus isFlagged={row.is_flagged} flags={flagsForRow(row)} hasGap={'contains_gaps' in row && row.contains_gaps} /></td></tr>)}</tbody></table>{!tableRows.length && <EmptyState title="Keine geflaggten Messwerte" text="Im aktuellen Ausschnitt ist kein Messwert mit einer Flag-Zuordnung vorhanden." />}</div><div className="px-5"><Pagination page={page} pageSize={10} total={filteredRows.length} onPage={setPage} /></div></Card>
    </>}
    <Dialog open={!!selected} onOpenChange={open => !open && setSelected(null)} title="Messwertdetail" description="Exakter gespeicherter Datensatz mit Flag-Herkunft" size="lg">{selected && <MeasurementDetail row={selected} flags={selectedFlags} events={selectedEvents} onEvent={eventId => navigate(`/ereignisse?event=${eventId}`)} />}</Dialog>
  </div>
}

function MeasurementChart({ title, description, option, onEvents, flagged, origin }: { title: string; description: string; option: EChartsOption; onEvents: Record<string, (params: unknown) => void>; flagged?: number; origin?: string }) { return <Card><CardHeader title={title} description={description} action={<div className="flex gap-2">{origin && <Badge tone="info">{origin}</Badge>}{flagged ? <Badge tone="danger">{flagged} geflaggt</Badge> : null}</div>} /><CardContent className="pt-2"><Chart option={option} height={320} onEvents={onEvents} /></CardContent></Card> }
function Quality({ label, value, warning }: { label: string; value: string; warning?: boolean }) { return <div className="rounded-lg border border-slate-100 p-4 dark:border-slate-800"><p className="text-xs text-slate-400">{label}</p><p className={`mt-1 text-xl font-semibold ${warning ? 'text-red-600' : 'text-slate-900 dark:text-white'}`}>{value}</p></div> }
function measurementSummary(row: Measurement) { if (row.level === 'BASIC') return `${formatNumber(row.rms_voltage)} V · ${formatNumber(row.rms_current)} A · ${formatNumber(row.frequency, 3)} Hz · THDS ${row.voltage_thds_percent === null ? 'n. v.' : `${formatNumber(row.voltage_thds_percent, 2)} %`}`; if (row.level === 'SHORT_TERM') return `${formatNumber(row.aggregated_rms)} V`; if (row.level === 'TEN_MINUTE') return `${formatNumber(row.aggregated_rms)} V · Pst ${formatNumber(row.pst_flicker, 3)}`; return `${formatNumber(row.long_term_rms)} V · Plt ${formatNumber(row.plt_flicker, 3)}` }
function FlagStatus({ isFlagged, flags, hasGap }: { isFlagged: boolean; flags: FlagPropagation[]; hasGap: boolean }) { const flag = flags[0]; return <div className="flex flex-wrap gap-2">{isFlagged && <Badge tone="danger"><AlertTriangle className="h-3 w-3" />{flag ? `${flag.is_propagated ? 'Fortgepflanzt' : 'Direkt'} · #${flag.source_event_id}` : 'Geflaggt'}</Badge>}{hasGap && <Badge tone="warning">Messlücke</Badge>}{!isFlagged && !hasGap && <Badge tone="success">Plausibel</Badge>}</div> }

function MeasurementDetail({ row, flags, events, onEvent }: { row: Measurement; flags: FlagPropagation[]; events: PQEvent[]; onEvent: (eventId: number) => void }) {
  const entries = Object.entries(row).filter(([key]) => !['level', 'harmonics', 'interharmonics'].includes(key))
  const eventMap = new Map(events.map(event => [event.event_id, event]))
  return <div>
    <div className="mb-5 flex flex-wrap gap-2"><Badge tone={row.is_flagged ? 'danger' : 'success'}>{row.is_flagged ? 'Geflaggter Messwert' : 'Nicht geflaggt'}</Badge><Badge tone="info">{levelLabel[row.level]}</Badge>{flags.map(flag => <Badge key={flag.flag_id} tone="warning">{flag.is_propagated ? 'Fortgepflanzt' : 'Direkt'} von #{flag.source_event_id}</Badge>)}</div>
    {flags.length > 0 && <div className="mb-5"><h3 className="section-title">Flag-Herkunft</h3><div className="mt-3 space-y-3">{flags.map(flag => { const event = eventMap.get(flag.source_event_id); return <div key={flag.flag_id} className="rounded-xl border border-red-200 bg-red-50/60 p-4 dark:border-red-900 dark:bg-red-950/40"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-red-500">Flag #{flag.flag_id} · {flag.is_propagated ? 'fortgepflanzt' : 'direkt'}</p><p className="mt-1 font-semibold text-red-900 dark:text-red-100">PQ-Ereignis #{flag.source_event_id}{event ? ` · ${eventLabel[event.event_type]}` : ''}</p><p className="mt-1 text-xs text-red-700/80 dark:text-red-200/80">Zielstufe {flag.target_level}{flag.propagated_from_level ? ` · von ${flag.propagated_from_level}` : ' · Ursprungsstufe'}</p></div><Button size="sm" onClick={() => onEvent(flag.source_event_id)}><Link2 className="h-3.5 w-3.5" />Ereignis öffnen</Button></div></div> })}</div></div>}
    {row.is_flagged && flags.length === 0 && <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">Der Messwert ist als geflaggt gespeichert, aber im geladenen Ausschnitt wurde keine passende Flag-Herkunft gefunden.</div>}
    <dl className="grid gap-3 sm:grid-cols-2">{entries.map(([key, value]) => <div key={key} className="rounded-lg border border-slate-100 p-3 dark:border-slate-800"><dt className="text-xs uppercase tracking-wide text-slate-400">{key}</dt><dd className="mt-1 break-all font-mono text-sm text-slate-800 dark:text-slate-200">{key === 'timestamp' ? formatDateTime(String(value)) : String(value)}</dd></div>)}</dl>
  </div>
}

function measurementFlagKey(channelId: number, level: MeasurementLevel, timestamp: string) { return `${channelId}:${level}:${timestamp}` }

function formatFlagTooltip(raw: unknown) {
  const marker = raw as { data?: { flag?: FlagPropagation; relatedFlagCount?: number } }
  const flag = marker.data?.flag
  if (!flag) return 'Geflaggter Messwert · Herkunft nicht im geladenen Ausschnitt'
  return `Geflaggter Messwert<br/>Flag #${flag.flag_id} · ${flag.is_propagated ? 'fortgepflanzt' : 'direkt'}<br/>PQ-Ereignis #${flag.source_event_id}${(marker.data?.relatedFlagCount ?? 0) > 1 ? `<br/>${marker.data?.relatedFlagCount} Flag-Zuordnungen` : ''}`
}
