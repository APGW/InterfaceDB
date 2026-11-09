import type { BasicMeasurement, Channel, CommunicationConfiguration, DspConfiguration, ExportLog, FlagPropagation, Measurement, MeasurementUnitConfiguration, Meter, MeterConfiguration, MeterSystemState, PQEvent, ShortTermMeasurement, TenMinuteMeasurement, ThresholdSetting, TimeSyncStatus, TwoHourMeasurement, VoltageUnbalanceMeasurement } from '../types/power-quality'

const now = new Date()
now.setSeconds(0, 0)
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString()
const wave = (i: number, amplitude = 1, phase = 0) => Math.sin(i / 6 + phase) * amplitude
const jitter = (i: number, scale = 1) => (((i * 9301 + 49297) % 233280) / 233280 - .5) * scale

export const meters: Meter[] = [
  { meter_id: 'PQM-BER-01', firmware_version: '3.8.2', active_class: 'CLASS_A', created_at: at(525_600) },
  { meter_id: 'PQM-BER-02', firmware_version: '3.8.2', active_class: 'CLASS_A', created_at: at(391_000) },
  { meter_id: 'PQM-LAB-01', firmware_version: '3.7.9', active_class: 'CLASS_S', created_at: at(180_000) },
]

const channelTypes = ['L1', 'L2', 'L3', 'N', 'PE'] as const
export const channels: Channel[] = meters.flatMap((meter, meterIndex) => channelTypes.map((type, index) => ({
  channel_id: meterIndex * 10 + index + 1,
  meter_id: meter.meter_id,
  channel_name: `${meter.meter_id} · ${type}`,
  channel_type: type,
  calibration_factor: index < 3 ? 1.0002 + index * .0001 : 1,
  transducer_id: 100 + meterIndex * 10 + index,
  u_ratio: index < 3 ? 100 : 1,
  i_ratio: index < 3 ? 5 : 1,
})))

export const configurations: MeterConfiguration[] = meters.flatMap((meter, index) => [
  { config_id: index * 10 + 1, meter_id: meter.meter_id, udin: 230, f_nominal: 50, hysteresis: 0, max_uncertainty_ms: 20, class_a_enforces_gapless: true, class_a_handle_overlaps: true, valid_from: at(120_000 + index * 2000) },
  { config_id: index * 10 + 2, meter_id: meter.meter_id, udin: 230, f_nominal: 50, hysteresis: .02, max_uncertainty_ms: index === 2 ? 25 : 20, class_a_enforces_gapless: true, class_a_handle_overlaps: true, valid_from: at(15_000 + index * 400) },
])

export const thresholds: ThresholdSetting[] = meters.flatMap((meter, index) => [
  { threshold_id: index * 10 + 1, meter_id: meter.meter_id, dip_threshold: .90, swell_threshold: 1.10, interruption_threshold: .10, valid_from: at(120_000) },
  { threshold_id: index * 10 + 2, meter_id: meter.meter_id, dip_threshold: index === 2 ? .88 : .90, swell_threshold: 1.10, interruption_threshold: .10, valid_from: at(15_000) },
])

export const measurementUnits: MeasurementUnitConfiguration[] = meters.map((meter, i) => ({ measurement_unit_config_id: i + 1, meter_id: meter.meter_id, sample_rate_hz: i === 2 ? 12_800 : 25_600, polyphase_mode: true, valid_from: at(100_000) }))
export const dsp: DspConfiguration[] = meters.map((meter, i) => ({ config_id: i + 1, meter_id: meter.meter_id, buffer_size: i === 2 ? 2048 : 1024, fft_bins: 50, valid_from: at(20_000 + i * 1000) }))
export const communication: CommunicationConfiguration[] = meters.map((meter, i) => ({ meter_id: meter.meter_id, port_number: 502 + i, protocol_name: i === 2 ? 'MQTT/TLS' : 'Modbus TCP' }))

const threePhaseChannels = channels.filter(c => ['L1', 'L2', 'L3'].includes(c.channel_type))
export const measurements: Measurement[] = threePhaseChannels.flatMap((channel) => {
  const phase = channel.channel_type === 'L1' ? 0 : channel.channel_type === 'L2' ? 2.1 : 4.2
  const basic: BasicMeasurement[] = Array.from({ length: 145 }, (_, idx) => {
    const i = 144 - idx
    return {
      level: 'BASIC', timestamp: at(i * 10), channel_id: channel.channel_id,
      is_flagged: false, quality_class: channel.meter_id === 'PQM-LAB-01' ? 'CLASS_S' : 'CLASS_A',
      rms_voltage: 230 + wave(idx, 2.2, phase) + jitter(idx + channel.channel_id, 1.4),
      rms_current: 18 + wave(idx, 3.4, phase) + jitter(idx * 2 + channel.channel_id, 1.2),
      frequency: 50 + wave(idx, .035, phase) + jitter(idx * 3, .018),
      voltage_thds_percent: 1.65 + Math.abs(wave(idx, .7, phase)) + Math.abs(jitter(idx + channel.channel_id, .18)),
      harmonics: Array.from({ length: 50 }, (_, h) => Math.max(0, 4.8 / (h + 1) + jitter(h + idx, .12))),
      interharmonics: Array.from({ length: 50 }, (_, h) => Math.max(0, 1.8 / (h + 1) + jitter(h * 2 + idx, .08))),
    }
  })
  const shortTerm: ShortTermMeasurement[] = Array.from({ length: 97 }, (_, idx) => ({
    level: 'SHORT_TERM', timestamp: at((96 - idx) * 15), channel_id: channel.channel_id, is_flagged: false,
    quality_class: channel.meter_id === 'PQM-LAB-01' ? 'CLASS_S' : 'CLASS_A', aggregated_rms: 230 + wave(idx, 1.8, phase), contains_gaps: idx === 31 && channel.channel_type === 'L2',
  }))
  const tenMinute: TenMinuteMeasurement[] = Array.from({ length: 73 }, (_, idx) => ({
    level: 'TEN_MINUTE', timestamp: at((72 - idx) * 20), channel_id: channel.channel_id, is_flagged: false,
    quality_class: channel.meter_id === 'PQM-LAB-01' ? 'CLASS_S' : 'CLASS_A', aggregated_rms: 230 + wave(idx, 1.4, phase), pst_flicker: .42 + Math.abs(wave(idx, .25, phase)), is_utc_aligned: true, has_overlap1: true,
  }))
  const twoHour: TwoHourMeasurement[] = Array.from({ length: 25 }, (_, idx) => ({
    level: 'TWO_HOUR', timestamp: at((24 - idx) * 60), channel_id: channel.channel_id, is_flagged: false,
    quality_class: channel.meter_id === 'PQM-LAB-01' ? 'CLASS_S' : 'CLASS_A', plt_flicker: .36 + Math.abs(wave(idx, .16, phase)), long_term_rms: 230 + wave(idx, .9, phase),
  }))
  return [...basic, ...shortTerm, ...tenMinute, ...twoHour]
})

const eventSpecs = [
  [1001, 8, 'PQM-BER-01', 1, 'VOLTAGE_DIP', .90, .71, 420, 'DIP_THRESHOLD_VIOLATION'],
  [1002, 188, 'PQM-BER-01', 2, 'VOLTAGE_SWELL', 1.10, 1.18, 260, 'SWELL_THRESHOLD_VIOLATION'],
  [1003, 347, 'PQM-BER-02', 11, 'VOLTAGE_INTERRUPTION', .10, .04, 1180, 'INTERRUPTION_THRESHOLD_VIOLATION'],
  [1004, 611, 'PQM-LAB-01', 21, 'VOLTAGE_DIP', .88, .76, 680, 'DIP_THRESHOLD_VIOLATION'],
  [1005, 918, 'PQM-BER-02', 13, 'VOLTAGE_DIP', .90, .82, 340, 'DIP_THRESHOLD_VIOLATION'],
  [1006, 1260, 'PQM-BER-01', 3, 'VOLTAGE_SWELL', 1.10, 1.14, 190, 'SWELL_THRESHOLD_VIOLATION'],
  // Gleichzeitiges dreiphasiges Ereignisbündel für die Live-Demodarstellung.
  [1009, 2.5, 'PQM-BER-01', 1, 'VOLTAGE_DIP', .90, .68, 510, 'DIP_THRESHOLD_VIOLATION'],
  [1010, 2.5, 'PQM-BER-01', 2, 'VOLTAGE_SWELL', 1.10, 1.21, 380, 'SWELL_THRESHOLD_VIOLATION'],
  [1011, 2.5, 'PQM-BER-01', 3, 'VOLTAGE_INTERRUPTION', .10, .03, 1240, 'INTERRUPTION_THRESHOLD_VIOLATION'],
  // Weitere zeitlich getrennte Ereignisse innerhalb des 15-Minuten-Fensters.
  [1012, 5.5, 'PQM-BER-01', 1, 'VOLTAGE_SWELL', 1.10, 1.16, 230, 'SWELL_THRESHOLD_VIOLATION'],
  [1013, 10.5, 'PQM-BER-01', 2, 'VOLTAGE_DIP', .90, .79, 610, 'DIP_THRESHOLD_VIOLATION'],
  [1014, 13.5, 'PQM-BER-01', 3, 'VOLTAGE_INTERRUPTION', .10, .06, 890, 'INTERRUPTION_THRESHOLD_VIOLATION'],
] as const

const disturbanceEvents: PQEvent[] = eventSpecs.map(spec => {
  const [id, minutes, meter, channel, type, threshold, extreme, duration, cause] = spec
  return {
    event_id: id, timestamp: at(minutes), event_source: 'FlaggingEvaluator', event_type: type,
    meter_id: meter, channel_id: channel, phase: channels.find(c => c.channel_id === channel)?.channel_type ?? 'L1',
    threshold_value: threshold, actual_extreme_value: extreme, duration_ms: duration, flag_cause: cause,
    ...(type === 'VOLTAGE_DIP' ? { dip_residual_voltage: extreme * 230 } : {}),
    ...(type === 'VOLTAGE_SWELL' ? { swell_peak_voltage: extreme * 230 } : {}),
    ...(type === 'VOLTAGE_INTERRUPTION' ? { interruption_voltage: extreme * 230 } : {}),
  }
})

export const events: PQEvent[] = [
  ...disturbanceEvents,
  {
    event_id: 1007, timestamp: at(42), event_source: 'RvcDetector', event_type: 'RAPID_VOLTAGE_CHANGE',
    meter_id: 'PQM-BER-01', channel_id: 1, phase: 'L1', threshold_value: 3, actual_extreme_value: 4.7,
    duration_ms: 680, flag_cause: 'RVC_DETECTED', voltage_change_percent: 4.7,
    steady_state_before_voltage: 230.4, steady_state_after_voltage: 219.6,
    phase_angle_before_deg: .3, phase_angle_after_deg: 2.1,
  },
  {
    event_id: 1008, timestamp: at(96), event_source: 'TransientDetector', event_type: 'VOLTAGE_TRANSIENT',
    meter_id: 'PQM-BER-01', channel_id: 2, phase: 'L2', threshold_value: 325, actual_extreme_value: 612,
    duration_ms: .84, flag_cause: 'TRANSIENT_DETECTED', transient_peak_voltage: 612,
    transient_rise_time_us: 18, transient_duration_us: 840, transient_polarity: 'POSITIVE',
  },
  {
    event_id: 1015, timestamp: at(6.5), event_source: 'RvcDetector', event_type: 'RAPID_VOLTAGE_CHANGE',
    meter_id: 'PQM-BER-01', channel_id: 3, phase: 'L3', threshold_value: 3, actual_extreme_value: 5.2,
    duration_ms: 720, flag_cause: 'RVC_DETECTED', voltage_change_percent: 5.2,
    steady_state_before_voltage: 231.2, steady_state_after_voltage: 219.1,
    phase_angle_before_deg: 120.4, phase_angle_after_deg: 122.2,
  },
  {
    event_id: 1016, timestamp: at(11.5), event_source: 'TransientDetector', event_type: 'VOLTAGE_TRANSIENT',
    meter_id: 'PQM-BER-01', channel_id: 2, phase: 'L2', threshold_value: 325, actual_extreme_value: -548,
    duration_ms: .46, flag_cause: 'TRANSIENT_DETECTED', transient_peak_voltage: -548,
    transient_rise_time_us: 11, transient_duration_us: 460, transient_polarity: 'NEGATIVE',
  },
]

export const voltageUnbalance: VoltageUnbalanceMeasurement[] = meters.flatMap((meter, meterIndex) => Array.from({ length: 289 }, (_, idx) => ({
  timestamp: at((288 - idx) * 5), meter_id: meter.meter_id,
  negative_sequence_percent: .42 + Math.abs(wave(idx, .28, meterIndex * .7)) + Math.abs(jitter(idx + meterIndex, .08)),
  zero_sequence_percent: .18 + Math.abs(wave(idx, .12, meterIndex * .4)),
  l1_magnitude_v: 230 + wave(idx, 1.2, meterIndex * .2), l1_angle_deg: .2 + wave(idx, .35),
  l2_magnitude_v: 228.8 + wave(idx, 1.4, 2.1 + meterIndex * .2), l2_angle_deg: -119.4 + wave(idx, .45, .8),
  l3_magnitude_v: 231.1 + wave(idx, 1.1, 4.2 + meterIndex * .2), l3_angle_deg: 120.7 + wave(idx, .4, 1.4),
  is_flagged: false, quality_class: meter.active_class,
})))

const levelOffsets = { BASIC: 0, SHORT_TERM: 3, TEN_MINUTE: 10, TWO_HOUR: 120 }
export const flags: FlagPropagation[] = events.flatMap((event, eventIndex) => (Object.keys(levelOffsets) as (keyof typeof levelOffsets)[]).map((level, levelIndex) => ({
  flag_id: 5000 + eventIndex * 10 + levelIndex,
  source_event_id: event.event_id,
  meter_id: event.meter_id,
  channel_id: event.channel_id,
  target_level: level,
  value_timestamp: new Date(new Date(event.timestamp).getTime() + levelOffsets[level] * 60_000).toISOString(),
  is_propagated: levelIndex > 0,
  propagated_from_level: levelIndex === 0 ? null : (['BASIC', 'SHORT_TERM', 'TEN_MINUTE'] as const)[levelIndex - 1],
  created_at: new Date(new Date(event.timestamp).getTime() + (levelIndex + 1) * 25_000).toISOString(),
})))

flags.forEach(flag => {
  const nearest = measurements.filter(m => m.channel_id === flag.channel_id && m.level === flag.target_level).sort((a, b) => Math.abs(new Date(a.timestamp).getTime() - new Date(flag.value_timestamp).getTime()) - Math.abs(new Date(b.timestamp).getTime() - new Date(flag.value_timestamp).getTime()))[0]
  if (nearest) {
    nearest.is_flagged = true
    flag.value_timestamp = nearest.timestamp
  }
})

export const timeSync: TimeSyncStatus[] = meters.flatMap((meter, mi) => Array.from({ length: 24 }, (_, idx) => ({
  timestamp: at((23 - idx) * 30 + (mi === 2 ? 80 : 2)), meter_id: meter.meter_id,
  is_locked_to_utc: !(meter.meter_id === 'PQM-LAB-01' && idx > 18), pps_signal_active: !(meter.meter_id === 'PQM-LAB-01' && idx > 18), sat_count: meter.meter_id === 'PQM-LAB-01' && idx > 18 ? 3 : 9 + ((idx + mi) % 4),
})))

export const systemStates: MeterSystemState[] = meters.flatMap((meter, mi) => Array.from({ length: 12 }, (_, idx) => ({
  timestamp: at((11 - idx) * 60 + (mi === 1 ? 14 : 1)), meter_id: meter.meter_id,
  current_state: meter.meter_id === 'PQM-LAB-01' && idx === 7 ? 'MAINTENANCE' : 'MEASURING', uptime_seconds: 540_000 + idx * 3_600 + mi * 12_000,
})))

export const exportLogs: ExportLog[] = Array.from({ length: 16 }, (_, i) => ({
  export_id: 9000 + i, meter_id: meters[i % meters.length].meter_id, export_timestamp: at(120 + i * 160), protocol_name: 'PQDIF', file_path: `/exports/${meters[i % meters.length].meter_id.toLowerCase()}_${at(120 + i * 160).slice(0, 10)}.pqd`, success: i !== 5,
}))

export const demoData = { meters, channels, configurations, thresholds, measurementUnits, dsp, communication, measurements, voltageUnbalance, events, flags, timeSync, systemStates, exportLogs }
