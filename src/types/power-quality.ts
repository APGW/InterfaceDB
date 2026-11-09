export type MeasurementClass = 'CLASS_A' | 'CLASS_S'
export type ChannelType = 'L1' | 'L2' | 'L3' | 'N' | 'PE'
export type MeasurementLevel = 'BASIC' | 'SHORT_TERM' | 'TEN_MINUTE' | 'TWO_HOUR'
export type EventType = 'VOLTAGE_DIP' | 'VOLTAGE_SWELL' | 'VOLTAGE_INTERRUPTION' | 'RAPID_VOLTAGE_CHANGE' | 'VOLTAGE_TRANSIENT'
export type SystemState = 'INIT' | 'RUNNING' | 'MEASURING' | 'ERROR' | 'MAINTENANCE'

export interface Meter {
  meter_id: string
  firmware_version: string
  active_class: MeasurementClass
  created_at: string
}

export interface Channel {
  channel_id: number
  meter_id: string
  channel_name: string
  channel_type: ChannelType
  calibration_factor: number
  transducer_id: number
  u_ratio: number
  i_ratio: number
}

export interface MeterConfiguration {
  config_id: number
  meter_id: string
  udin: number
  f_nominal: number
  hysteresis: number
  max_uncertainty_ms: number
  class_a_enforces_gapless: boolean
  class_a_handle_overlaps: boolean
  valid_from: string
}

export interface ThresholdSetting {
  threshold_id: number
  meter_id: string
  dip_threshold: number
  swell_threshold: number
  interruption_threshold: number
  valid_from: string
}

export interface BasicMeasurement {
  level: 'BASIC'
  timestamp: string
  channel_id: number
  is_flagged: boolean
  quality_class: MeasurementClass
  rms_voltage: number
  rms_current: number
  frequency: number
  voltage_thds_percent: number | null
  harmonics: number[]
  interharmonics: number[]
}

export interface ShortTermMeasurement {
  level: 'SHORT_TERM'
  timestamp: string
  channel_id: number
  is_flagged: boolean
  quality_class: MeasurementClass
  aggregated_rms: number
  contains_gaps: boolean
}

export interface TenMinuteMeasurement {
  level: 'TEN_MINUTE'
  timestamp: string
  channel_id: number
  is_flagged: boolean
  quality_class: MeasurementClass
  aggregated_rms: number
  pst_flicker: number
  is_utc_aligned: boolean
  has_overlap1: boolean
}

export interface TwoHourMeasurement {
  level: 'TWO_HOUR'
  timestamp: string
  channel_id: number
  is_flagged: boolean
  quality_class: MeasurementClass
  plt_flicker: number
  long_term_rms: number
}

export type Measurement = BasicMeasurement | ShortTermMeasurement | TenMinuteMeasurement | TwoHourMeasurement

export interface PQEvent {
  event_id: number
  timestamp: string
  event_source: string
  event_type: EventType
  meter_id: string
  channel_id: number
  phase: string
  threshold_value: number
  actual_extreme_value: number
  duration_ms: number
  flag_cause: string
  dip_residual_voltage?: number
  swell_peak_voltage?: number
  interruption_voltage?: number
  voltage_change_percent?: number
  steady_state_before_voltage?: number
  steady_state_after_voltage?: number
  phase_angle_before_deg?: number
  phase_angle_after_deg?: number
  transient_peak_voltage?: number
  transient_rise_time_us?: number
  transient_duration_us?: number
  transient_polarity?: 'POSITIVE' | 'NEGATIVE'
}

export interface VoltageUnbalanceMeasurement {
  timestamp: string
  meter_id: string
  negative_sequence_percent: number
  zero_sequence_percent: number
  l1_magnitude_v: number
  l1_angle_deg: number
  l2_magnitude_v: number
  l2_angle_deg: number
  l3_magnitude_v: number
  l3_angle_deg: number
  is_flagged: boolean
  quality_class: MeasurementClass
}

export interface FlagPropagation {
  flag_id: number
  source_event_id: number
  meter_id: string
  channel_id: number
  target_level: MeasurementLevel
  value_timestamp: string
  is_propagated: boolean
  propagated_from_level: MeasurementLevel | null
  created_at: string
}

export interface TimeSyncStatus {
  timestamp: string
  meter_id: string
  is_locked_to_utc: boolean
  pps_signal_active: boolean
  sat_count: number
}

export interface MeterSystemState {
  timestamp: string
  meter_id: string
  current_state: SystemState
  uptime_seconds: number
}

export interface DspConfiguration { config_id: number; meter_id: string; buffer_size: number; fft_bins: number; valid_from: string }
export interface CommunicationConfiguration { meter_id: string; port_number: number; protocol_name: string }
export interface MeasurementUnitConfiguration { measurement_unit_config_id: number; meter_id: string; sample_rate_hz: number; polyphase_mode: boolean; valid_from: string }
export interface ExportLog { export_id: number; meter_id: string; export_timestamp: string; protocol_name: string; file_path: string; success: boolean }

export interface ApiList<T> { items: T[]; total: number; limit: number; offset: number }
export interface QueryRange { from?: string; to?: string }
export interface MeasurementQuery extends QueryRange { meter_id: string; channel_id: number; level: MeasurementLevel; metric?: string; limit?: number; offset?: number }
export interface EventQuery extends QueryRange { meter_id?: string; event_type?: EventType | ''; channel_id?: number; limit?: number; offset?: number }
export interface FlagQuery extends QueryRange { meter_id?: string; channel_id?: number; target_level?: MeasurementLevel | ''; source_event_id?: number }

export interface MeterDetail extends Meter {
  channels: Channel[]
  configurations: MeterConfiguration[]
  thresholds: ThresholdSetting[]
  measurement_units: MeasurementUnitConfiguration[]
  dsp_configurations: DspConfiguration[]
  communication: CommunicationConfiguration
}

export interface DashboardMeter extends Meter {
  latest_state: MeterSystemState | null
  latest_time_sync: TimeSyncStatus | null
  active_flag_count: number
}

export interface DashboardData {
  meters: DashboardMeter[]
  active_flag_count: number
  event_count: number
  utc_locked_count: number
  events: PQEvent[]
  flags: FlagPropagation[]
}

export type LiveStatus = 'live' | 'delayed' | 'no_data'
export type LivePhase = 'L1' | 'L2' | 'L3'
export type QualityMetric = 'frequency' | 'pst' | 'plt' | 'long_term_rms' | 'voltage_unbalance'

export interface LiveVoltagePoint {
  timestamp: string
  phase: LivePhase
  min_voltage: number
  max_voltage: number
  avg_voltage: number
  voltage_thds_percent: number | null
  frequency: number
  is_flagged: boolean
}

export interface LiveMetricPoint {
  timestamp: string
  value: number
}

export interface LiveThresholdSegment {
  from: string
  to: string
  udin: number
  dip_voltage: number
  swell_voltage: number
}

export interface DashboardLiveData {
  server_time: string
  last_measurement_timestamp: string | null
  status: LiveStatus
  cursor: string
  voltage: LiveVoltagePoint[]
  events: PQEvent[]
  thresholds: LiveThresholdSegment[]
  metrics: Record<QualityMetric, LiveMetricPoint[]>
  voltage_unbalance: VoltageUnbalanceMeasurement[]
}

export interface DashboardLiveQuery {
  meter_id: string
  from: string
  to: string
  after?: string
  bucket_seconds: number
  limit: number
}

export interface SystemStatusData {
  time_sync: TimeSyncStatus[]
  states: MeterSystemState[]
  dsp: DspConfiguration[]
  communication: CommunicationConfiguration | null
  exports: ExportLog[]
}
