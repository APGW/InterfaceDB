export type Phase = 'L1' | 'L2' | 'L3';
export type EventType = 'Voltage Dip' | 'Voltage Swell' | 'Voltage Interruption' | 'Rapid Voltage Change' | 'Spannungstransient';
export type RangeMode = 'live' | '15m' | '1h' | '24h';
export type QualityMetric = 'frequency' | 'pst' | 'plt' | 'longTermRms';

export interface VoltagePoint {
  timestamp: string;
  phase: Phase;
  rmsAvg: number;
  rmsMin: number;
  rmsMax: number;
  voltageThdsPercent: number;
  frequencyHz: number;
  isFlagged: boolean;
  sequence: number;
}

export interface PowerQualityEvent {
  id: string;
  timestamp: string;
  type: EventType;
  phase: Phase;
  durationMs: number;
  residualVoltagePercent?: number;
  sequence: number;
}

export interface PhasorValue {
  phase: Phase;
  magnitude: number;
  angleDeg: number;
}

export interface UnbalancePoint {
  timestamp: string;
  negativePercent: number;
  zeroPercent: number;
  phasors: PhasorValue[];
  sequence: number;
}

export interface QualityPoint {
  timestamp: string;
  frequencyHz: number;
  pst: number;
  plt: number;
  longTermRms: number;
  sequence: number;
}

export interface LiveEnvelope {
  serverTime: string;
  cursor: string;
  firstSequence: number;
  lastSequence: number;
  retentionStartSequence: number;
  hasMore: boolean;
  lastSeen: string;
  voltage: VoltagePoint[];
  events: PowerQualityEvent[];
  unbalance: UnbalancePoint[];
  quality: QualityPoint[];
  thresholds: { nominalVoltage: number; dipVoltage: number; swellVoltage: number };
}

export interface LiveState extends LiveEnvelope {
  connection: 'connecting' | 'online' | 'error';
  gapDetected: boolean;
  errorMessage: string | null;
}
