import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, defer, delay, map, of, timeout } from 'rxjs';
import { EventType, LiveEnvelope, Phase, PowerQualityEvent, QualityPoint, UnbalancePoint, VoltagePoint } from './live.models';
import { ApiConnectionConfig, LiveConfigService } from './live-config.service';

/**
 * REST contract used by the Angular client. Set demoMode to false when the
 * backend implements the two endpoints below. Polling cadence never determines
 * completeness: the cursor asks for every retained delta since the last reply.
 */
@Injectable({ providedIn: 'root' })
export class LiveApiService {
  constructor(private readonly http: HttpClient, private readonly liveConfig: LiveConfigService) {}

  getSnapshot(windowMinutes = 15, bucketSeconds = 5): Observable<LiveEnvelope> {
    const config = this.liveConfig.config();
    if (config.demoMode) return of(this.demoSnapshot(windowMinutes, bucketSeconds)).pipe(delay(140));
    const params = new HttpParams()
      .set('meter_id', config.meterId)
      .set('window_minutes', windowMinutes)
      .set('bucket_seconds', bucketSeconds)
      .set('limit', config.requestLimit);
    return this.http.get<LiveEnvelope>(this.url(config, config.snapshotPath), { params, headers: this.headers(config) }).pipe(timeout(config.timeoutMs));
  }

  getUpdates(afterCursor: string): Observable<LiveEnvelope> {
    const config = this.liveConfig.config();
    if (config.demoMode) return of(this.demoUpdates(afterCursor)).pipe(delay(90));
    const params = new HttpParams().set('meter_id', config.meterId).set('after_cursor', afterCursor).set('limit', config.requestLimit);
    return this.http.get<LiveEnvelope>(this.url(config, config.updatesPath), { params, headers: this.headers(config) }).pipe(timeout(config.timeoutMs));
  }

  getLastSeen(): Observable<{ serverTime: string; lastSeen: string }> {
    return this.getLastSeenFor(this.liveConfig.config());
  }

  testConnection(config: ApiConnectionConfig): Observable<{ ok: true; latencyMs: number }> {
    return defer(() => {
      const started = performance.now();
      return this.getLastSeenFor(config).pipe(map(() => ({ ok: true as const, latencyMs: Math.round(performance.now() - started) })));
    });
  }

  private getLastSeenFor(config: ApiConnectionConfig): Observable<{ serverTime: string; lastSeen: string }> {
    if (config.demoMode) {
      const now = new Date().toISOString();
      return of({ serverTime: now, lastSeen: now }).pipe(delay(60));
    }
    const params = new HttpParams().set('meter_id', config.meterId);
    return this.http.get<{ serverTime: string; lastSeen: string }>(this.url(config, config.lastSeenPath), { params, headers: this.headers(config) }).pipe(timeout(config.timeoutMs));
  }

  private url(config: ApiConnectionConfig, path: string): string {
    return `${config.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private headers(config: ApiConnectionConfig): HttpHeaders {
    return config.authenticationMode === 'bearer' && config.bearerToken
      ? new HttpHeaders({ Authorization: `Bearer ${config.bearerToken}` })
      : new HttpHeaders();
  }

  private demoSnapshot(windowMinutes: number, bucketSeconds: number): LiveEnvelope {
    const nowSequence = Math.floor(Date.now() / 1000);
    const windowSeconds = windowMinutes * 60;
    const start = nowSequence - windowSeconds;
    const step = Math.max(1, bucketSeconds);
    const voltage: VoltagePoint[] = [];
    const unbalance: UnbalancePoint[] = [];
    const quality: QualityPoint[] = [];

    // Five-second display aggregation keeps the chart readable; raw acquisition
    // and server-side event recognition remain independent from this UI window.
    for (let sequence = start; sequence <= nowSequence; sequence += step) {
      voltage.push(...this.voltageAt(sequence));
      unbalance.push(this.unbalanceAt(sequence));
      quality.push(this.qualityAt(sequence));
    }

    const eventOffsets: Array<[number, EventType, Phase, number, number?]> = [
      [-Math.round(windowSeconds * .90), 'Voltage Dip', 'L1', 210, 73],
      [-Math.round(windowSeconds * .78), 'Voltage Swell', 'L2', 180, 112],
      [-Math.round(windowSeconds * .65), 'Rapid Voltage Change', 'L3', 420],
      [-Math.round(windowSeconds * .53), 'Voltage Dip', 'L2', 310, 68],
      [-Math.round(windowSeconds * .53), 'Voltage Dip', 'L3', 310, 70],
      [-Math.round(windowSeconds * .37), 'Spannungstransient', 'L1', 12],
      [-Math.round(windowSeconds * .21), 'Voltage Interruption', 'L1', 860, 4],
      [-Math.round(windowSeconds * .21), 'Voltage Interruption', 'L2', 860, 3],
      [-Math.round(windowSeconds * .21), 'Voltage Interruption', 'L3', 860, 4],
      [-Math.round(windowSeconds * .06), 'Voltage Swell', 'L3', 240, 115],
    ];
    const events = eventOffsets.map(([offset, type, phase, duration, residual], index) =>
      this.eventAt(nowSequence + offset, type, phase, duration, residual, index),
    );

    return this.envelope(start, nowSequence, voltage, events, unbalance, quality, false);
  }

  private demoUpdates(afterCursor: string): LiveEnvelope {
    const requested = Number.parseInt(afterCursor, 10);
    const now = Math.floor(Date.now() / 1000);
    const safeCursor = Number.isFinite(requested) ? requested : now - 1;
    const first = Math.min(safeCursor + 1, now);
    const limitLast = Math.min(now, safeCursor + 60);
    const voltage: VoltagePoint[] = [];
    const unbalance: UnbalancePoint[] = [];
    const quality: QualityPoint[] = [];
    const events: PowerQualityEvent[] = [];

    for (let sequence = first; sequence <= limitLast && sequence > safeCursor; sequence += 1) {
      voltage.push(...this.voltageAt(sequence));
      unbalance.push(this.unbalanceAt(sequence));
      quality.push(this.qualityAt(sequence));
      if (sequence % 43 === 0) {
        events.push(this.eventAt(sequence, 'Voltage Dip', (['L1', 'L2', 'L3'] as Phase[])[sequence % 3], 190, 76, sequence));
      }
    }

    const last = limitLast > safeCursor ? limitLast : safeCursor;
    return this.envelope(first, last, voltage, events, unbalance, quality, last < now);
  }

  private envelope(
    firstSequence: number,
    lastSequence: number,
    voltage: VoltagePoint[],
    events: PowerQualityEvent[],
    unbalance: UnbalancePoint[],
    quality: QualityPoint[],
    hasMore: boolean,
  ): LiveEnvelope {
    const latest = voltage.at(-1)?.timestamp ?? new Date(lastSequence * 1000).toISOString();
    return {
      serverTime: new Date().toISOString(),
      cursor: String(lastSequence),
      firstSequence,
      lastSequence,
      retentionStartSequence: Math.floor(Date.now() / 1000) - 3600,
      hasMore,
      lastSeen: latest,
      voltage,
      events,
      unbalance,
      quality,
      thresholds: { nominalVoltage: 230, dipVoltage: 207, swellVoltage: 253 },
    };
  }

  private voltageAt(sequence: number): VoltagePoint[] {
    const phases: Phase[] = ['L1', 'L2', 'L3'];
    return phases.map((phase, index) => {
      const wave = Math.sin(sequence / 17 + index * 2.1);
      const faster = Math.sin(sequence / 4.7 + index) * 0.7;
      let rms = 230 + wave * 2.1 + faster;
      if (sequence % 257 === 0 && phase === 'L1') rms = 185;
      if (sequence % 389 === 0 && phase === 'L3') rms = 258;
      return {
        timestamp: new Date(sequence * 1000).toISOString(),
        phase,
        rmsAvg: rms,
        rmsMin: rms - 1.2,
        rmsMax: rms + 1.4,
        voltageThdsPercent: 1.35 + index * 0.22 + Math.abs(Math.sin(sequence / 31 + index)) * 0.9,
        frequencyHz: 50 + Math.sin(sequence / 22) * 0.025,
        isFlagged: rms < 207 || rms > 253,
        sequence,
      };
    });
  }

  private unbalanceAt(sequence: number): UnbalancePoint {
    const negativePercent = 0.65 + Math.abs(Math.sin(sequence / 29)) * 0.72;
    const zeroPercent = 0.18 + Math.abs(Math.cos(sequence / 41)) * 0.28;
    return {
      timestamp: new Date(sequence * 1000).toISOString(),
      negativePercent,
      zeroPercent,
      sequence,
      phasors: [
        { phase: 'L1', magnitude: 231.2, angleDeg: 0 },
        { phase: 'L2', magnitude: 226.8 - negativePercent, angleDeg: -118.1 },
        { phase: 'L3', magnitude: 229.1 + zeroPercent, angleDeg: 121.9 },
      ],
    };
  }

  private qualityAt(sequence: number): QualityPoint {
    return {
      timestamp: new Date(sequence * 1000).toISOString(),
      frequencyHz: 50 + Math.sin(sequence / 22) * 0.025,
      pst: 0.34 + Math.abs(Math.sin(sequence / 113)) * 0.31,
      plt: 0.27 + Math.abs(Math.cos(sequence / 487)) * 0.18,
      longTermRms: 230 + Math.sin(sequence / 701) * 1.35,
      sequence,
    };
  }

  private eventAt(
    sequence: number,
    type: EventType,
    phase: Phase,
    durationMs: number,
    residualVoltagePercent: number | undefined,
    suffix: number,
  ): PowerQualityEvent {
    return {
      id: `demo-${sequence}-${phase}-${suffix}`,
      timestamp: new Date(sequence * 1000).toISOString(),
      type,
      phase,
      durationMs,
      residualVoltagePercent,
      sequence,
    };
  }
}
