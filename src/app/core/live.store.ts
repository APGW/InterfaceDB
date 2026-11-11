import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, EMPTY, Subscription, catchError, exhaustMap, switchMap, tap, timer } from 'rxjs';
import { LiveApiService } from './live-api.service';
import { LiveConfigService } from './live-config.service';
import { LiveEnvelope, LiveState, RangeMode } from './live.models';

export const RANGE_CONFIG: Record<RangeMode, { label: string; minutes: number; bucketSeconds: number; polling: boolean }> = {
  live: { label: 'Live', minutes: 15, bucketSeconds: 5, polling: true },
  '15m': { label: '15 min', minutes: 15, bucketSeconds: 5, polling: false },
  '1h': { label: '1 h', minutes: 60, bucketSeconds: 30, polling: false },
  '24h': { label: '24 h', minutes: 1440, bucketSeconds: 360, polling: false },
};

@Injectable({ providedIn: 'root' })
export class LiveStore {
  private readonly api = inject(LiveApiService);
  private readonly liveConfig = inject(LiveConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly rateSubject = new BehaviorSubject<number>(this.liveConfig.config().pollingSeconds * 1000);
  private pollingSubscription?: Subscription;
  private receivedState: LiveState | null = null;

  readonly state = signal<LiveState | null>(null);
  readonly paused = signal(false);
  readonly pollingRateMs = signal(this.liveConfig.config().pollingSeconds * 1000);
  readonly rangeMode = signal<RangeMode>('live');
  readonly isLoading = signal(true);
  readonly isCatchingUp = signal(false);
  readonly lastPollAt = signal<string | null>(null);

  readonly latestVoltage = computed(() => {
    const points = this.state()?.voltage ?? [];
    const latest = new Map<string, number>();
    for (const point of points) latest.set(point.phase, point.rmsAvg);
    return latest;
  });

  readonly latestUnbalance = computed(() => this.state()?.unbalance.at(-1) ?? null);

  constructor() {
    this.loadSnapshot(true);
  }

  setRange(mode: RangeMode): void {
    if (mode === this.rangeMode() && this.state()) return;
    this.rangeMode.set(mode);
    this.paused.set(false);
    this.loadSnapshot(false);
  }

  setPollingRate(seconds: number): void {
    const boundedSeconds = Math.min(30, Math.max(0.5, seconds));
    const milliseconds = Math.round(boundedSeconds * 1000);
    this.pollingRateMs.set(milliseconds);
    this.liveConfig.update({ ...this.liveConfig.config(), pollingSeconds: boundedSeconds });
    this.rateSubject.next(milliseconds);
  }

  togglePause(): void {
    const next = !this.paused();
    this.paused.set(next);
    if (!next && this.receivedState) this.state.set(structuredClone(this.receivedState));
  }

  reload(): void {
    this.loadSnapshot(false);
  }

  private loadSnapshot(startPolling: boolean): void {
    this.isLoading.set(true);
    const range = RANGE_CONFIG[this.rangeMode()];
    const config = this.liveConfig.config();
    const bucketSeconds = this.rangeMode() === '1h' ? config.bucket1hSeconds
      : this.rangeMode() === '24h' ? config.bucket24hSeconds : config.bucket15mSeconds;
    this.api.getSnapshot(range.minutes, bucketSeconds).pipe(
      takeUntilDestroyed(this.destroyRef),
      tap((snapshot) => {
        const next: LiveState = {
          ...snapshot,
          connection: 'online',
          gapDetected: false,
          errorMessage: null,
        };
        this.receivedState = next;
        if (!this.paused()) this.state.set(structuredClone(next));
        this.isLoading.set(false);
        this.lastPollAt.set(new Date().toISOString());
        if (startPolling && !this.pollingSubscription) this.startPolling();
      }),
      catchError((error: unknown) => {
        this.isLoading.set(false);
        this.publishError(error);
        return EMPTY;
      }),
    ).subscribe();
  }

  private startPolling(): void {
    this.pollingSubscription = this.rateSubject.pipe(
      switchMap((rate) => timer(0, rate).pipe(
        // exhaustMap prevents a slow REST request from overlapping the next tick.
        exhaustMap(() => {
          if (!RANGE_CONFIG[this.rangeMode()].polling) {
            return this.api.getLastSeen().pipe(
              tap((heartbeat) => this.acceptHeartbeat(heartbeat)),
              catchError((error: unknown) => {
                this.publishError(error);
                return EMPTY;
              }),
            );
          }
          const cursor = this.receivedState?.cursor;
          if (!cursor) return EMPTY;
          return this.api.getUpdates(cursor).pipe(
            tap((delta) => this.acceptDelta(delta)),
            catchError((error: unknown) => {
              this.publishError(error);
              return EMPTY;
            }),
          );
        }),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  private acceptDelta(delta: LiveEnvelope): void {
    if (!RANGE_CONFIG[this.rangeMode()].polling) return;
    const current = this.receivedState;
    if (!current) return;

    if (delta.firstSequence > current.lastSequence + 1) {
      this.receivedState = { ...current, gapDetected: true, connection: 'error', errorMessage: 'Sequenzlücke erkannt – Snapshot wird neu geladen.' };
      if (!this.paused()) this.state.set(structuredClone(this.receivedState));
      this.loadSnapshot(false);
      return;
    }

    const cutoff = Date.now() - RANGE_CONFIG[this.rangeMode()].minutes * 60 * 1000;
    const voltage = [...current.voltage, ...delta.voltage].filter((point) => Date.parse(point.timestamp) >= cutoff);
    const eventsById = new Map([...current.events, ...delta.events].map((event) => [event.id, event]));
    const events = [...eventsById.values()].filter((event) => Date.parse(event.timestamp) >= cutoff);
    const unbalance = [...current.unbalance, ...delta.unbalance].filter((point) => Date.parse(point.timestamp) >= cutoff);
    const quality = [...current.quality, ...delta.quality].filter((point) => Date.parse(point.timestamp) >= cutoff);

    this.receivedState = {
      ...current,
      ...delta,
      voltage,
      events,
      unbalance,
      quality,
      connection: 'online',
      gapDetected: false,
      errorMessage: null,
    };
    this.lastPollAt.set(new Date().toISOString());
    if (!this.paused()) this.state.set(structuredClone(this.receivedState));

    if (delta.hasMore) {
      this.isCatchingUp.set(true);
      queueMicrotask(() => this.catchUp());
    } else {
      this.isCatchingUp.set(false);
    }
  }

  private acceptHeartbeat(heartbeat: { serverTime: string; lastSeen: string }): void {
    if (!this.receivedState) return;
    this.receivedState = {
      ...this.receivedState,
      serverTime: heartbeat.serverTime,
      lastSeen: heartbeat.lastSeen,
      connection: 'online',
      errorMessage: null,
    };
    if (!this.paused()) this.state.set(structuredClone(this.receivedState));
    this.lastPollAt.set(new Date().toISOString());
  }

  private catchUp(): void {
    const cursor = this.receivedState?.cursor;
    if (!cursor) return;
    this.api.getUpdates(cursor).pipe(
      takeUntilDestroyed(this.destroyRef),
      tap((delta) => this.acceptDelta(delta)),
      catchError((error: unknown) => {
        this.isCatchingUp.set(false);
        this.publishError(error);
        return EMPTY;
      }),
    ).subscribe();
  }

  private publishError(error: unknown): void {
    const message = error instanceof Error ? error.message : 'REST-Abfrage fehlgeschlagen';
    if (this.receivedState) {
      this.receivedState = { ...this.receivedState, connection: 'error', errorMessage: message };
      if (!this.paused()) this.state.set(structuredClone(this.receivedState));
    }
  }
}
