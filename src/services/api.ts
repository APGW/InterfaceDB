import { demoData } from './mock-data'
import type { ApiList, Channel, DashboardData, DashboardLiveData, DashboardLiveQuery, EventQuery, FlagPropagation, FlagQuery, LiveMetricPoint, LivePhase, LiveVoltagePoint, Measurement, MeasurementQuery, Meter, MeterConfiguration, MeterDetail, PQEvent, QualityMetric, SystemStatusData, VoltageUnbalanceMeasurement } from '../types/power-quality'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://DEIN-API-SERVER/api/v1'
export const DEMO_MODE = String(import.meta.env.VITE_DEMO_MODE ?? 'true').toLowerCase() === 'true'
const delay = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms))

export class ApiError extends Error {
  constructor(message: string, public status?: number) { super(message) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try { response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } }) }
  catch { throw new ApiError('Der API-Server ist nicht erreichbar. Prüfen Sie Netzwerk und VITE_API_BASE_URL.') }
  if (!response.ok) throw new ApiError(`API-Fehler ${response.status}: ${response.statusText}`, response.status)
  return response.json() as Promise<T>
}

const params = (values: Record<string, unknown>) => {
  const query = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') query.set(key, String(value)) })
  const output = query.toString(); return output ? `?${output}` : ''
}
const inRange = (timestamp: string, from?: string, to?: string) => (!from || timestamp >= from) && (!to || timestamp <= to)

export const api = {
  async getMeters(): Promise<Meter[]> {
    if (!DEMO_MODE) return request('/meters')
    await delay(); return demoData.meters
  },
  async getMeter(id: string): Promise<MeterDetail> {
    if (!DEMO_MODE) return request(`/meters/${encodeURIComponent(id)}`)
    await delay(); const meter = demoData.meters.find(item => item.meter_id === id)
    if (!meter) throw new ApiError('Messgerät nicht gefunden.', 404)
    return { ...meter, channels: demoData.channels.filter(c => c.meter_id === id), configurations: demoData.configurations.filter(c => c.meter_id === id), thresholds: demoData.thresholds.filter(c => c.meter_id === id), measurement_units: demoData.measurementUnits.filter(c => c.meter_id === id), dsp_configurations: demoData.dsp.filter(c => c.meter_id === id), communication: demoData.communication.find(c => c.meter_id === id)! }
  },
  async getChannels(meterId: string): Promise<Channel[]> {
    if (!DEMO_MODE) return request<Channel[]>(`/meters/${encodeURIComponent(meterId)}/channels`)
    await delay(100); return demoData.channels.filter(c => c.meter_id === meterId)
  },
  async getDashboard(query: { meter_id?: string; from?: string; to?: string }): Promise<DashboardData> {
    if (!DEMO_MODE) return request(`/dashboard${params(query)}`)
    await delay(); const selectedMeters = demoData.meters.filter(m => !query.meter_id || m.meter_id === query.meter_id)
    const events = demoData.events.filter(e => selectedMeters.some(m => m.meter_id === e.meter_id) && inRange(e.timestamp, query.from, query.to))
    const flags = demoData.flags.filter(f => selectedMeters.some(m => m.meter_id === f.meter_id) && inRange(f.value_timestamp, query.from, query.to))
    const dashboardMeters = selectedMeters.map(meter => ({ ...meter,
      latest_state: demoData.systemStates.filter(s => s.meter_id === meter.meter_id).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null,
      latest_time_sync: demoData.timeSync.filter(s => s.meter_id === meter.meter_id).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null,
      active_flag_count: flags.filter(f => f.meter_id === meter.meter_id).length,
    }))
    return { meters: dashboardMeters, active_flag_count: flags.length, event_count: events.length, utc_locked_count: dashboardMeters.filter(m => m.latest_time_sync?.is_locked_to_utc).length, events, flags }
  },
  async getDashboardLive(query: DashboardLiveQuery): Promise<DashboardLiveData> {
    if (!DEMO_MODE) return request(`/dashboard/live${params(query as unknown as Record<string, unknown>)}`)
    await delay(90)
    const serverNow = Date.now()
    const slotMs = Math.max(2, query.bucket_seconds) * 1000
    const endMs = Math.min(new Date(query.to).getTime(), Math.floor(serverNow / slotMs) * slotMs)
    const requestedStart = new Date(query.from).getTime()
    const afterMs = query.after ? new Date(query.after).getTime() : null
    const startMs = afterMs === null
      ? Math.max(requestedStart, endMs - (query.limit - 1) * slotMs)
      : afterMs + slotMs
    const timestamps: number[] = []
    for (let timestamp = startMs; timestamp <= endMs && timestamps.length < query.limit; timestamp += slotMs) timestamps.push(timestamp)
    const phases: LivePhase[] = ['L1', 'L2', 'L3']
    const voltage: LiveVoltagePoint[] = phases.flatMap((phase, phaseIndex) => timestamps.map((timestamp) => {
      const step = timestamp / slotMs
      const phaseShift = phaseIndex * 2.1
      const avg = 230 + Math.sin(step / 8 + phaseShift) * 2.15 + Math.sin(step / 31) * .55
      const event = demoData.events.find(item => item.meter_id === query.meter_id && item.phase === phase && Math.abs(new Date(item.timestamp).getTime() - timestamp) < slotMs * 1.2)
      const eventVoltage = !event ? avg
        : event.event_type === 'RAPID_VOLTAGE_CHANGE' ? event.steady_state_after_voltage ?? avg
          : event.event_type === 'VOLTAGE_TRANSIENT' ? avg
            : event.actual_extreme_value * 230
      return {
        timestamp: new Date(timestamp).toISOString(), phase,
        min_voltage: Math.min(eventVoltage, avg - .65 - phaseIndex * .08),
        max_voltage: Math.max(eventVoltage, avg + .72 + phaseIndex * .06),
        avg_voltage: avg,
        voltage_thds_percent: 1.55 + Math.abs(Math.sin(step / 13 + phaseShift)) * .82 + phaseIndex * .08,
        frequency: 50 + Math.sin(step / 17) * .028 + phaseIndex * .002,
        is_flagged: Boolean(event),
      }
    }))
    const metricFromVoltage = (metric: QualityMetric): LiveMetricPoint[] => voltage.filter(point => point.phase === 'L1').map(point => ({ timestamp: point.timestamp, value: metric === 'frequency' ? point.frequency : point.avg_voltage }))
    const l1Channel = demoData.channels.find(channel => channel.meter_id === query.meter_id && channel.channel_type === 'L1')
    const storedMetric = (level: Measurement['level'], key: 'pst_flicker' | 'plt_flicker' | 'long_term_rms'): LiveMetricPoint[] => demoData.measurements
      .filter(item => item.channel_id === l1Channel?.channel_id && item.level === level && inRange(item.timestamp, query.from, query.to))
      .map(item => ({ timestamp: item.timestamp, value: Number((item as unknown as Record<string, unknown>)[key]) }))
    const selectedMeter = demoData.meters.find(item => item.meter_id === query.meter_id)
    const voltageUnbalanceSamples: VoltageUnbalanceMeasurement[] = timestamps.map(timestamp => {
      const minute = timestamp / 60_000
      const slowWave = Math.sin(minute * .72)
      const secondaryWave = Math.sin(minute * .29 + 1.4)
      return {
        timestamp: new Date(timestamp).toISOString(), meter_id: query.meter_id,
        negative_sequence_percent: .55 + (slowWave + 1) * .22 + Math.abs(secondaryWave) * .18,
        zero_sequence_percent: .14 + (Math.sin(minute * .48 + .8) + 1) * .085,
        l1_magnitude_v: 230.8 + Math.sin(minute * .63) * 1.4,
        l1_angle_deg: .25 + Math.sin(minute * .31) * .55,
        l2_magnitude_v: 228.4 + Math.sin(minute * .57 + 2.1) * 2.1,
        l2_angle_deg: -118.9 + Math.sin(minute * .37 + .6) * 1.15,
        l3_magnitude_v: 232.1 + Math.sin(minute * .51 + 4.2) * 1.8,
        l3_angle_deg: 121.2 + Math.sin(minute * .34 + 1.2) * .95,
        is_flagged: false,
        quality_class: selectedMeter?.active_class ?? 'CLASS_A',
      }
    })
    const voltageUnbalance: LiveMetricPoint[] = voltageUnbalanceSamples.map(item => ({ timestamp: item.timestamp, value: item.negative_sequence_percent }))
    const latestConfig = demoData.configurations.filter(item => item.meter_id === query.meter_id).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]
    const latestThreshold = demoData.thresholds.filter(item => item.meter_id === query.meter_id).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0]
    const initialRequest = afterMs === null
    const events = demoData.events.filter(event => event.meter_id === query.meter_id && inRange(event.timestamp, query.from, query.to) && (initialRequest || new Date(event.timestamp).getTime() > (afterMs ?? 0)))
    const cursor = new Date(endMs).toISOString()
    return {
      server_time: new Date(serverNow).toISOString(),
      last_measurement_timestamp: voltage.length ? cursor : query.after ?? null,
      status: voltage.length || query.after ? 'live' : 'no_data', cursor, voltage, events,
      thresholds: latestConfig && latestThreshold ? [{ from: query.from, to: query.to, udin: latestConfig.udin, dip_voltage: latestConfig.udin * latestThreshold.dip_threshold, swell_voltage: latestConfig.udin * latestThreshold.swell_threshold }] : [],
      metrics: {
        frequency: metricFromVoltage('frequency'),
        pst: storedMetric('TEN_MINUTE', 'pst_flicker'),
        plt: storedMetric('TWO_HOUR', 'plt_flicker'),
        long_term_rms: storedMetric('TWO_HOUR', 'long_term_rms'),
        voltage_unbalance: voltageUnbalance,
      },
      voltage_unbalance: voltageUnbalanceSamples,
    }
  },
  async getMeasurements(query: MeasurementQuery): Promise<ApiList<Measurement>> {
    if (!DEMO_MODE) return request(`/measurements${params(query as unknown as Record<string, unknown>)}`)
    await delay(); const rows = demoData.measurements.filter(m => m.channel_id === query.channel_id && m.level === query.level && inRange(m.timestamp, query.from, query.to))
    const offset = query.offset ?? 0, limit = query.limit ?? 1000
    return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit }
  },
  async getEvents(query: EventQuery = {}): Promise<ApiList<PQEvent>> {
    if (!DEMO_MODE) return request(`/events${params(query as unknown as Record<string, unknown>)}`)
    await delay(); const rows = demoData.events.filter(e => (!query.meter_id || e.meter_id === query.meter_id) && (!query.event_type || e.event_type === query.event_type) && (!query.channel_id || e.channel_id === query.channel_id) && inRange(e.timestamp, query.from, query.to)).sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    const offset = query.offset ?? 0, limit = query.limit ?? 20
    return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit }
  },
  async getEvent(id: number): Promise<PQEvent> {
    if (!DEMO_MODE) return request(`/events/${id}`)
    await delay(100); const item = demoData.events.find(e => e.event_id === id); if (!item) throw new ApiError('Ereignis nicht gefunden.', 404); return item
  },
  async getFlags(query: FlagQuery = {}): Promise<FlagPropagation[]> {
    if (!DEMO_MODE) return request(`/flags${params(query as unknown as Record<string, unknown>)}`)
    await delay(); return demoData.flags.filter(f => (!query.meter_id || f.meter_id === query.meter_id) && (!query.channel_id || f.channel_id === query.channel_id) && (!query.target_level || f.target_level === query.target_level) && (!query.source_event_id || f.source_event_id === query.source_event_id) && inRange(f.value_timestamp, query.from, query.to)).sort((a, b) => b.value_timestamp.localeCompare(a.value_timestamp))
  },
  async getConfigurations(meterId: string): Promise<MeterConfiguration[]> {
    if (!DEMO_MODE) return request(`/meters/${encodeURIComponent(meterId)}/configurations/history`)
    await delay(); return demoData.configurations.filter(c => c.meter_id === meterId).sort((a, b) => b.valid_from.localeCompare(a.valid_from))
  },
  async createConfiguration(meterId: string, value: Omit<MeterConfiguration, 'config_id' | 'meter_id'>): Promise<MeterConfiguration> {
    if (DEMO_MODE) throw new ApiError('Im Demo-Modus werden keine Schreibvorgänge simuliert.')
    return request(`/meters/${encodeURIComponent(meterId)}/configurations`, { method: 'POST', body: JSON.stringify(value) })
  },
  async getSystemStatus(meterId: string): Promise<SystemStatusData> {
    if (!DEMO_MODE) return request(`/meters/${encodeURIComponent(meterId)}/system-status`)
    await delay(); return { time_sync: demoData.timeSync.filter(s => s.meter_id === meterId), states: demoData.systemStates.filter(s => s.meter_id === meterId), dsp: demoData.dsp.filter(s => s.meter_id === meterId), communication: demoData.communication.find(c => c.meter_id === meterId) ?? null, exports: demoData.exportLogs.filter(e => e.meter_id === meterId) }
  },
}
