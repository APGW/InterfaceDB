import type { EChartsOption } from 'echarts'
import { Activity, ArrowRight, Clock3, Gauge, Pause, Play, Radio, RefreshCw, Timer, Waves, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chart, timeAxis, valueAxis, zoom } from '../components/Charts'
import { PhasorDiagram, type PhasorVector } from '../components/PhasorDiagram'
import { Badge, Button, Card, CardContent, CardHeader, Select } from '../components/ui'
import { eventLabel, formatDateTime, formatDuration, formatNumber } from '../lib/utils'
import { api } from '../services/api'
import { useApp } from '../state/AppContext'
import type { DashboardLiveData, EventType, LiveMetricPoint, LivePhase, LiveStatus, LiveThresholdSegment, LiveVoltagePoint, PQEvent, QualityMetric, VoltageUnbalanceMeasurement } from '../types/power-quality'

type RangeMode = 'live' | '15m' | '1h' | '24h'
const rangeConfig: Record<RangeMode, { label: string; minutes: number; bucket: number; limit: number; polling: boolean }> = {
  live: { label: 'Live', minutes: 15, bucket: 2, limit: 500, polling: true },
  '15m': { label: '15 Minuten', minutes: 15, bucket: 2, limit: 500, polling: false },
  '1h': { label: '1 Stunde', minutes: 60, bucket: 6, limit: 600, polling: false },
  '24h': { label: '24 Stunden', minutes: 1440, bucket: 72, limit: 1200, polling: false },
}
const phaseColors: Record<LivePhase, string> = { L1: '#2296B5', L2: '#6E56CF', L3: '#10B981' }
const phaseSymbols: Record<LivePhase, 'circle' | 'diamond' | 'triangle'> = { L1: 'circle', L2: 'diamond', L3: 'triangle' }
const metricLabels: Record<QualityMetric, { label: string; unit: string }> = {
  frequency: { label: 'Frequenz', unit: 'Hz' }, pst: { label: 'Pst-Flicker', unit: 'Pst' }, plt: { label: 'Plt-Flicker', unit: 'Plt' }, long_term_rms: { label: 'Langfristiger RMS-Wert', unit: 'V' },
  voltage_unbalance: { label: 'Spannungsunsymmetrie', unit: '%' },
}
const eventTypes: EventType[] = ['VOLTAGE_DIP', 'VOLTAGE_SWELL', 'VOLTAGE_INTERRUPTION', 'RAPID_VOLTAGE_CHANGE', 'VOLTAGE_TRANSIENT']
const eventColor = (type: EventType) => ({ VOLTAGE_DIP: '#F59E0B', VOLTAGE_SWELL: '#EF4444', VOLTAGE_INTERRUPTION: '#991B1B', RAPID_VOLTAGE_CHANGE: '#7C3AED', VOLTAGE_TRANSIENT: '#0EA5E9' })[type]
const emptyMetrics = (): Record<QualityMetric, LiveMetricPoint[]> => ({ frequency: [], pst: [], plt: [], long_term_rms: [], voltage_unbalance: [] })
const metricOrigin = (metric: QualityMetric) => metric === 'frequency' ? 'Übergeben · Basic' : metric === 'pst' ? 'Übergeben · Ten Minute' : metric === 'plt' || metric === 'long_term_rms' ? 'Übergeben · Two Hour' : 'Übergeben · Unsymmetrie'

export default function DashboardPage() {
  const { meters, globalMeterId } = useApp()
  const navigate = useNavigate()
  const [meterId, setMeterId] = useState(globalMeterId)
  const [rangeMode, setRangeMode] = useState<RangeMode>('live')
  const [paused, setPaused] = useState(false)
  const [status, setStatus] = useState<LiveStatus>('no_data')
  const [lastMeasurement, setLastMeasurement] = useState<string | null>(null)
  const [voltage, setVoltage] = useState<LiveVoltagePoint[]>([])
  const [events, setEvents] = useState<PQEvent[]>([])
  const [thresholds, setThresholds] = useState<LiveThresholdSegment[]>([])
  const [unbalanceSamples, setUnbalanceSamples] = useState<VoltageUnbalanceMeasurement[]>([])
  const [metrics, setMetrics] = useState<Record<QualityMetric, LiveMetricPoint[]>>(emptyMetrics)
  const [metric, setMetric] = useState<QualityMetric>('voltage_unbalance')
  const [eventType, setEventType] = useState<EventType | ''>('')
  const [eventPhase, setEventPhase] = useState<LivePhase | ''>('')
  const [thdsPhase, setThdsPhase] = useState<LivePhase | 'ALL'>('ALL')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const cursorRef = useRef<string | undefined>(undefined)
  const requestActive = useRef(false)
  const serverOffsetRef = useRef(0)

  useEffect(() => { if (!meterId && globalMeterId) setMeterId(globalMeterId) }, [globalMeterId, meterId])
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer) }, [])

  const applyResponse = useCallback((response: DashboardLiveData, reset: boolean) => {
    const limit = rangeConfig[rangeMode].limit
    const mergeVoltage = (previous: LiveVoltagePoint[]) => {
      const source = reset ? response.voltage : [...previous, ...response.voltage]
      const unique = new Map(source.map(point => [`${point.phase}:${point.timestamp}`, point]))
      return (['L1', 'L2', 'L3'] as LivePhase[]).flatMap(phase => [...unique.values()].filter(point => point.phase === phase).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit))
    }
    const mergeMetric = (name: QualityMetric, previous: LiveMetricPoint[]) => {
      const source = reset ? response.metrics[name] : [...previous, ...response.metrics[name]]
      const unique = new Map(source.map(point => [point.timestamp, point]))
      return [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit)
    }
    setVoltage(mergeVoltage)
    setEvents(previous => {
      const source = reset ? response.events : [...previous, ...response.events]
      return [...new Map(source.map(event => [event.event_id, event])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    })
    setMetrics(previous => ({
      frequency: mergeMetric('frequency', previous.frequency), pst: mergeMetric('pst', previous.pst),
      plt: mergeMetric('plt', previous.plt), long_term_rms: mergeMetric('long_term_rms', previous.long_term_rms),
      voltage_unbalance: mergeMetric('voltage_unbalance', previous.voltage_unbalance),
    }))
    setUnbalanceSamples(previous => {
      const source = reset ? response.voltage_unbalance : [...previous, ...response.voltage_unbalance]
      return [...new Map(source.map(item => [item.timestamp, item])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit)
    })
    if (response.thresholds.length) setThresholds(response.thresholds)
    serverOffsetRef.current = new Date(response.server_time).getTime() - Date.now()
    setStatus(response.status); setLastMeasurement(response.last_measurement_timestamp); cursorRef.current = response.cursor
  }, [rangeMode])

  const load = useCallback(async (reset = false) => {
    if (!meterId || requestActive.current) return
    requestActive.current = true
    if (reset) setLoading(true)
    try {
      const config = rangeConfig[rangeMode]
      const to = new Date()
      const from = new Date(to.getTime() - config.minutes * 60_000)
      const response = await api.getDashboardLive({ meter_id: meterId, from: from.toISOString(), to: to.toISOString(), after: reset ? undefined : cursorRef.current, bucket_seconds: config.bucket, limit: config.limit })
      applyResponse(response, reset); setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Live-Daten konnten nicht geladen werden.')
      setStatus('no_data')
    } finally { setLoading(false); requestActive.current = false }
  }, [meterId, rangeMode, applyResponse])

  useEffect(() => {
    cursorRef.current = undefined; setVoltage([]); setEvents([]); setThresholds([]); setMetrics(emptyMetrics()); setUnbalanceSamples([])
    void load(true)
  }, [meterId, rangeMode])

  useEffect(() => {
    if (!rangeConfig[rangeMode].polling || paused) return
    const timer = window.setInterval(() => void load(false), 2000)
    return () => window.clearInterval(timer)
  }, [rangeMode, paused, load])

  const phases = useMemo(() => Object.fromEntries((['L1', 'L2', 'L3'] as LivePhase[]).map(phase => [phase, voltage.filter(point => point.phase === phase).sort((a, b) => a.timestamp.localeCompare(b.timestamp))])) as Record<LivePhase, LiveVoltagePoint[]>, [voltage])
  const filteredEvents = useMemo(() => events.filter(event => (!eventType || event.event_type === eventType) && (!eventPhase || event.phase === eventPhase)), [events, eventType, eventPhase])
  const latestL1 = phases.L1.at(-1)
  const latestThds = (thdsPhase === 'ALL' ? voltage : phases[thdsPhase]).filter(point => point.voltage_thds_percent !== null).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1)
  const latestUnbalance = [...unbalanceSamples].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1)
  const dataAgeSeconds = lastMeasurement ? Math.max(0, Math.round((clock + serverOffsetRef.current - new Date(lastMeasurement).getTime()) / 1000)) : null
  const effectiveStatus: LiveStatus = status === 'live' && dataAgeSeconds !== null && dataAgeSeconds > 10 ? 'delayed' : status
  const timeWindow = useMemo(() => {
    const end = lastMeasurement ? new Date(lastMeasurement).getTime() : Date.now()
    return { min: end - rangeConfig[rangeMode].minutes * 60_000, max: end }
  }, [lastMeasurement, rangeMode])

  const voltageOption: EChartsOption = useMemo(() => {
    const threshold = thresholds.at(-1)
    const thresholdLines = threshold ? [{ name: 'Udin', yAxis: threshold.udin, lineStyle: { color: '#64748B', type: 'solid' as const } }, { name: 'Dip-Grenze', yAxis: threshold.dip_voltage, lineStyle: { color: '#F59E0B', type: 'dashed' as const } }, { name: 'Swell-Grenze', yAxis: threshold.swell_voltage, lineStyle: { color: '#EF4444', type: 'dashed' as const } }] : []
    const eventLines = filteredEvents.map(event => ({ name: eventLabel[event.event_type], xAxis: event.timestamp, label: { show: false }, lineStyle: { color: eventColor(event.event_type), type: 'dotted' as const, opacity: .75 } }))
    const eventAreas = filteredEvents.map(event => ([
      { name: eventLabel[event.event_type], xAxis: event.timestamp, itemStyle: { color: eventColor(event.event_type), opacity: .09 } },
      { xAxis: new Date(new Date(event.timestamp).getTime() + Math.max(event.duration_ms, 6_000)).toISOString() },
    ]))
    const voltageSeries = (['L1', 'L2', 'L3'] as LivePhase[]).flatMap((phase, index) => [
      { name: `${phase} Minimum`, type: 'line' as const, stack: `band-${phase}`, showSymbol: false, silent: true, tooltip: { show: false }, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, data: phases[phase].map(point => [point.timestamp, point.min_voltage]) },
      { name: `${phase} Min/Max`, type: 'line' as const, stack: `band-${phase}`, showSymbol: false, silent: true, tooltip: { show: false }, lineStyle: { opacity: 0 }, areaStyle: { color: phaseColors[phase], opacity: .10 }, data: phases[phase].map(point => [point.timestamp, point.max_voltage - point.min_voltage]) },
      { name: phase, type: 'line' as const, showSymbol: false, smooth: false, lineStyle: { width: 1.8, color: phaseColors[phase] }, itemStyle: { color: phaseColors[phase] }, data: phases[phase].map(point => [point.timestamp, point.avg_voltage, point.min_voltage, point.max_voltage]), ...(index === 0 ? { markLine: { symbol: ['none', 'none'], label: { formatter: '{b}' }, data: [...thresholdLines, ...eventLines] }, markArea: { silent: true, label: { show: false }, data: eventAreas } } : {}) },
    ])
    return {
      animation: false,
      grid: { left: 58, right: 94, top: 46, bottom: 72 },
      legend: { top: 4, data: ['L1', 'L2', 'L3'] },
      xAxis: { ...timeAxis, min: timeWindow.min, max: timeWindow.max, splitNumber: 8, axisLabel: { hideOverlap: true, margin: 12 }, splitLine: { show: true, lineStyle: { color: '#94A3B8', opacity: .18, type: 'dashed' } } },
      yAxis: { ...valueAxis('V'), min: 0, max: 280 },
      dataZoom: zoom,
      tooltip: { trigger: 'axis', formatter: (raw: unknown) => formatVoltageTooltip(raw) },
      series: voltageSeries as EChartsOption['series'],
    }
  }, [phases, thresholds, filteredEvents, timeWindow])

  const eventOption: EChartsOption = useMemo(() => {
    const groups = new Map<string, PQEvent[]>()
    filteredEvents.forEach(event => groups.set(event.timestamp, [...(groups.get(event.timestamp) ?? []), event]))
    const eventData = filteredEvents.map(event => {
      const group = groups.get(event.timestamp) ?? [event]
      const labelEvent = group.reduce((highest, item) => eventTypes.indexOf(item.event_type) > eventTypes.indexOf(highest.event_type) ? item : highest)
      const showGroupLabel = group.length > 1 && labelEvent.event_id === event.event_id
      return {
        value: [event.timestamp, eventLabel[event.event_type], event.duration_ms],
        symbol: phaseSymbols[event.phase as LivePhase] ?? 'circle',
        itemStyle: { color: eventColor(event.event_type), borderColor: '#F8FAFC', borderWidth: 1 },
        label: showGroupLabel ? { show: true, formatter: `${group.length} simultan`, position: 'top' as const, distance: 10, color: '#F8FAFC', backgroundColor: '#334155', borderRadius: 5, padding: [4, 7], fontSize: 10, fontWeight: 600 } : { show: false },
        event,
      }
    })
    return {
      animation: false,
      legend: { show: false },
      grid: { left: 150, right: 28, top: 34, bottom: 78 },
      xAxis: { ...timeAxis, min: timeWindow.min, max: timeWindow.max, splitNumber: 8, axisLabel: { hideOverlap: true, margin: 14 }, splitLine: { show: true, lineStyle: { color: '#94A3B8', opacity: .24, type: 'dashed' } } },
      yAxis: {
        type: 'category', data: eventTypes.map(type => eventLabel[type]), axisTick: { show: false }, axisLabel: { margin: 16 },
        axisLine: { lineStyle: { color: '#64748B' } },
        splitLine: { show: true, lineStyle: { color: '#94A3B8', opacity: .30 } },
        splitArea: { show: true, areaStyle: { color: ['rgba(148,163,184,.035)', 'rgba(148,163,184,.085)'] } },
      },
      dataZoom: zoom,
      tooltip: { trigger: 'item', formatter: (raw: unknown) => formatEventTooltip(raw) },
      series: [{ name: 'PQ-Ereignisse', type: 'scatter', symbolSize: (value: unknown) => { const row = value as [string, string, number]; return Math.min(30, 12 + Math.sqrt(row[2] || 0) / 2) }, data: eventData }] as EChartsOption['series'],
    }
  }, [filteredEvents, timeWindow])

  const thdsOption: EChartsOption = useMemo(() => ({ legend: { top: 4 }, xAxis: timeAxis, yAxis: { ...valueAxis('%'), min: 0 }, dataZoom: zoom, series: (['L1', 'L2', 'L3'] as LivePhase[]).filter(phase => thdsPhase === 'ALL' || phase === thdsPhase).map(phase => ({ name: phase, type: 'line', showSymbol: false, lineStyle: { width: 1.8, color: phaseColors[phase] }, itemStyle: { color: phaseColors[phase] }, data: phases[phase].filter(point => point.voltage_thds_percent !== null).map(point => [point.timestamp, point.voltage_thds_percent]) })) as EChartsOption['series'] }), [phases, thdsPhase])
  const metricOption: EChartsOption = useMemo(() => {
    const shared = {
      animation: false,
      grid: { left: 58, right: 24, top: 48, bottom: 70 },
      xAxis: { ...timeAxis, min: timeWindow.min, max: timeWindow.max, splitNumber: 6, axisLabel: { hideOverlap: true, margin: 12 }, splitLine: { show: true, lineStyle: { color: '#94A3B8', opacity: .18, type: 'dashed' as const } } },
      dataZoom: zoom,
      tooltip: { trigger: 'axis' as const },
    }
    if (metric === 'voltage_unbalance') return {
      ...shared,
      legend: { top: 4, data: ['Negativsystem', 'Nullsystem'] },
      yAxis: { ...valueAxis('%'), min: 0 },
      tooltip: { trigger: 'axis', valueFormatter: (value: unknown) => `${formatNumber(Number(value), 3)} %` },
      series: [
        { name: 'Negativsystem', type: 'line', showSymbol: false, lineStyle: { width: 2.2, color: '#F59E0B' }, itemStyle: { color: '#F59E0B' }, areaStyle: { color: '#F59E0B', opacity: .08 }, data: unbalanceSamples.map(item => [item.timestamp, item.negative_sequence_percent]) },
        { name: 'Nullsystem', type: 'line', showSymbol: false, lineStyle: { width: 1.8, color: '#6E56CF' }, itemStyle: { color: '#6E56CF' }, data: unbalanceSamples.map(item => [item.timestamp, item.zero_sequence_percent]) },
      ],
    }
    return {
      ...shared,
      yAxis: valueAxis(metricLabels[metric].unit),
      tooltip: { trigger: 'axis', valueFormatter: (value: unknown) => `${formatNumber(Number(value), metric === 'frequency' ? 3 : 2)} ${metricLabels[metric].unit}` },
      series: [{ name: metricLabels[metric].label, type: 'line', showSymbol: metrics[metric].length < 30, smooth: false, lineStyle: { width: 2 }, areaStyle: { opacity: .06 }, data: metrics[metric].map(point => [point.timestamp, point.value]) }],
    }
  }, [metrics, metric, unbalanceSamples, timeWindow])
  const unbalanceVectors: PhasorVector[] = latestUnbalance ? [
    { label: 'L1', magnitude: latestUnbalance.l1_magnitude_v, angleDeg: latestUnbalance.l1_angle_deg, color: phaseColors.L1 },
    { label: 'L2', magnitude: latestUnbalance.l2_magnitude_v, angleDeg: latestUnbalance.l2_angle_deg, color: phaseColors.L2 },
    { label: 'L3', magnitude: latestUnbalance.l3_magnitude_v, angleDeg: latestUnbalance.l3_angle_deg, color: phaseColors.L3 },
  ] : []

  const kpis = [
    { label: 'Spannung L1', value: latestL1 ? `${formatNumber(latestL1.avg_voltage, 1)} V` : '—', hint: latestL1 ? `Min ${formatNumber(latestL1.min_voltage, 1)} · Max ${formatNumber(latestL1.max_voltage, 1)} V` : 'Keine Daten', icon: Gauge, color: 'bg-cyan-50 text-brand dark:bg-cyan-950' },
    { label: 'Frequenz', value: latestL1 ? `${formatNumber(latestL1.frequency, 3)} Hz` : '—', hint: 'Basic · L1', icon: Activity, color: 'bg-violet-50 text-violet-600 dark:bg-violet-950' },
    { label: 'Spannungs-THDS', value: latestThds?.voltage_thds_percent !== null && latestThds?.voltage_thds_percent !== undefined ? `${formatNumber(latestThds.voltage_thds_percent, 2)} %` : 'Nicht verfügbar', hint: thdsPhase === 'ALL' ? 'Neuester Phasenwert' : thdsPhase, icon: Waves, color: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950' },
    { label: 'PQ-Ereignisse', value: String(filteredEvents.length), hint: rangeConfig[rangeMode].label, icon: Zap, color: 'bg-amber-50 text-amber-600 dark:bg-amber-950' },
  ]

  return <div>
    <div className="mb-5 flex flex-col gap-4 2xl:flex-row 2xl:items-end 2xl:justify-between"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm text-slate-500">Verdichtete Echtzeitüberwachung mit maximal vier zentralen Visualisierungen</p><StatusBadge status={effectiveStatus} paused={paused} /></div><p className="mt-1 text-xs text-slate-400">Letzter Messwert: {lastMeasurement ? formatDateTime(lastMeasurement) : 'nicht verfügbar'}{dataAgeSeconds !== null ? ` · Datenalter ${dataAgeSeconds} s` : ''}</p></div><div className="flex flex-wrap items-center gap-2"><Select className="w-44" value={meterId} onChange={event => setMeterId(event.target.value)}>{meters.map(meter => <option key={meter.meter_id}>{meter.meter_id}</option>)}</Select><div className="flex rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">{(Object.keys(rangeConfig) as RangeMode[]).map(mode => <button key={mode} onClick={() => setRangeMode(mode)} className={`rounded-md px-3 py-2 text-xs font-semibold transition ${rangeMode === mode ? 'bg-brand text-white' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{rangeConfig[mode].label}</button>)}</div><Button variant={paused ? 'primary' : 'secondary'} disabled={rangeMode !== 'live'} onClick={() => setPaused(value => !value)}>{paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{paused ? 'Fortsetzen' : 'Live pausieren'}</Button><Button variant="secondary" size="icon" onClick={() => { cursorRef.current = undefined; void load(true) }} aria-label="Daten neu laden"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button></div></div>
    {error && <div className="mb-5 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200"><Radio className="h-4 w-4" />{error} Es werden keine Demo-Daten als reale Werte eingesetzt.</div>}
    <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">{kpis.map(({ label, value, hint, icon: Icon, color }) => <Card key={label} className="p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 truncate text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{value}</p><p className="mt-1 truncate text-xs text-slate-400">{hint}</p></div><div className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${color}`}><Icon className="h-5 w-5" /></div></div></Card>)}</div>
    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      <Card className="xl:col-span-2"><CardHeader title="1. Dreiphasiger Spannungsverlauf" description="Mittelwert mit Min/Max-Band · L1/L2/L3 · Udin und historisch gültige Grenzwerte" action={<div className="flex items-center gap-2"><Badge tone="info">Übergeben · Basic</Badge><Button variant="ghost" size="sm" onClick={() => navigate(`/messdaten?meter=${meterId}`)}>Detailanalyse<ArrowRight className="h-3.5 w-3.5" /></Button></div>} /><CardContent className="pt-2"><Chart option={voltageOption} height={370} /></CardContent></Card>
      <Card><CardHeader title="2. Power-Quality-Ereignisse" description="Zeitlich getrennt · gleiche Zeitposition = simultan" action={<div className="flex flex-wrap justify-end gap-2"><Badge tone="warning">Erkannt</Badge><Select className="h-8 w-28 text-xs" value={eventPhase} onChange={event => setEventPhase(event.target.value as LivePhase | '')}><option value="">Alle Phasen</option><option>L1</option><option>L2</option><option>L3</option></Select><Select className="h-8 w-44 text-xs" value={eventType} onChange={event => setEventType(event.target.value as EventType | '')}><option value="">Alle Typen</option>{eventTypes.map(type => <option key={type} value={type}>{eventLabel[type]}</option>)}</Select></div>} /><CardContent className="pt-2"><div className="mb-1 flex flex-wrap items-center gap-4 px-1 text-[11px] font-semibold text-slate-500"><span className="text-brand">● L1</span><span className="text-violet-500">◆ L2</span><span className="text-emerald-500">▲ L3</span><span className="ml-auto font-normal text-slate-400">Farbe = Ereignistyp · Form = Phase</span></div><Chart option={eventOption} height={330} /><div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-5">{eventTypes.map(type => <div key={type} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800"><p className="text-[10px] uppercase tracking-wide text-slate-400">{eventLabel[type]}</p><p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">{filteredEvents.filter(event => event.event_type === type).length}</p></div>)}</div></CardContent></Card>
      <Card><CardHeader title="3. Spannungs-THDS" description="Vom Messgerät/DSP gelieferter THDS-Verlauf in Prozent" action={<div className="flex items-center gap-2"><Badge tone="info">Übergeben · DSP</Badge><Select className="h-8 w-28 text-xs" value={thdsPhase} onChange={event => setThdsPhase(event.target.value as LivePhase | 'ALL')}><option value="ALL">Alle Phasen</option><option>L1</option><option>L2</option><option>L3</option></Select></div>} /><CardContent className="pt-2"><Chart option={thdsOption} height={375} /></CardContent></Card>
      <Card className="xl:col-span-2"><CardHeader title="4. Netzqualitätskennzahlen" description="Frequenz · Flicker · Unsymmetrie" action={<div className="flex items-center gap-2"><Badge tone="neutral">{metricOrigin(metric)}</Badge><Select className="h-8 w-56 text-xs" value={metric} onChange={event => setMetric(event.target.value as QualityMetric)}>{(Object.keys(metricLabels) as QualityMetric[]).map(name => <option key={name} value={name}>{metricLabels[name].label}</option>)}</Select></div>} /><CardContent className="pt-2"><QualityVisualization metric={metric} option={metricOption} unbalance={latestUnbalance} unbalanceVectors={unbalanceVectors} /></CardContent></Card>
    </div>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900"><span className="flex items-center gap-2"><Timer className="h-4 w-4 text-brand" />Polling: {rangeMode === 'live' ? 'alle 2 Sekunden' : 'deaktiviert'} · Bucket: {rangeConfig[rangeMode].bucket} s · Maximal {rangeConfig[rangeMode].limit} Punkte je Reihe</span><span>{paused ? 'Darstellung pausiert; Datenerfassung läuft weiter.' : 'Fehlende Phasenwerte werden nicht interpoliert.'}</span></div>
  </div>
}

function StatusBadge({ status, paused }: { status: LiveStatus; paused: boolean }) {
  if (paused) return <Badge tone="warning"><Pause className="h-3 w-3" />Pausiert</Badge>
  if (status === 'live') return <Badge tone="success"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Live</Badge>
  if (status === 'delayed') return <Badge tone="warning"><Clock3 className="h-3 w-3" />Verzögert</Badge>
  return <Badge tone="danger"><Radio className="h-3 w-3" />Keine Daten</Badge>
}

function QualityVisualization({ metric, option, unbalance, unbalanceVectors }: { metric: QualityMetric; option: EChartsOption; unbalance?: VoltageUnbalanceMeasurement; unbalanceVectors: PhasorVector[] }) {
  if (metric === 'voltage_unbalance' && unbalance) return <div className="grid gap-4 lg:grid-cols-[minmax(320px,.8fr)_1.2fr]"><PhasorDiagram title="Dreiphasige Spannungszeiger" vectors={unbalanceVectors} unit="V" /><div><Chart option={option} height={285} /><div className="mt-3 grid gap-2 sm:grid-cols-2"><MetricValue label="Negativsystem" value={`${formatNumber(unbalance.negative_sequence_percent, 3)} %`} /><MetricValue label="Nullsystem" value={`${formatNumber(unbalance.zero_sequence_percent, 3)} %`} /></div></div></div>
  return <Chart option={option} height={330} />
}

function MetricValue({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800"><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 font-mono text-sm font-semibold text-slate-800 dark:text-slate-100">{value}</p></div> }

function formatVoltageTooltip(raw: unknown) {
  const params = (Array.isArray(raw) ? raw : [raw]) as { seriesName?: string; data?: unknown[]; axisValue?: string }[]
  const title = params[0]?.axisValue ? formatDateTime(params[0].axisValue) : ''
  return [title, ...params.map(item => { const data = item.data ?? []; return `${item.seriesName}: <b>${formatNumber(Number(data[1]), 2)} V</b><br/><span style="color:#94a3b8">Min ${formatNumber(Number(data[2]), 2)} · Max ${formatNumber(Number(data[3]), 2)} V</span>` })].join('<br/>')
}

function formatEventTooltip(raw: unknown) {
  const item = raw as { data?: { event?: PQEvent } }
  const event = item.data?.event
  if (!event) return ''
  const unit = event.event_type === 'VOLTAGE_TRANSIENT' ? 'V' : event.event_type === 'RAPID_VOLTAGE_CHANGE' ? '%' : 'p.u.'
  return `${eventLabel[event.event_type]} · #${event.event_id}<br/>${formatDateTime(event.timestamp)}<br/>Phase ${event.phase} · ${formatDuration(event.duration_ms)}<br/>Extremwert ${formatNumber(event.actual_extreme_value, 2)} ${unit}`
}
