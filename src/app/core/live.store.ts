import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, EMPTY, Subscription, catchError, exhaustMap, switchMap, tap, timer } from 'rxjs';
import { LiveApiService } from './live-api.service';
import { LiveConfigService } from './live-config.service';
import { LiveEnvelope, LiveState, PowerQualityEvent, RangeMode } from './live.models';

export const RANGE_CONFIG: Record<RangeMode, { label: string; minutes: number; bucketSeconds: number; polling: boolean }> = {
  live: { label: 'Live', minutes: 15, bucketSeconds: 5, polling: true },
  '15m': { label: '15 min', minutes: 15, bucketSeconds: 5, polling: false },
  '1h': { label: '1 h', minutes: 60, bucketSeconds: 30, polling: false },
  '24h': { label: '24 h', minutes: 1440, bucketSeconds: 360, polling: false },
};

export interface DiagnosticAlert {
  kind: 'no-new-data' | 'server-unreachable';
  title: string;
  message: string;
  detectedAt: string;
}

export interface DiagnosticArchiveEntry extends DiagnosticAlert {
  id: string;
  status: 'active' | 'resolved';
  resolvedAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class LiveStore {
  private readonly api = inject(LiveApiService);
  private readonly liveConfig = inject(LiveConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly rateSubject = new BehaviorSubject<number>(this.liveConfig.config().pollingSeconds * 1000);
  private pollingSubscription?: Subscription;
  private receivedState: LiveState | null = null;
  private lastSnapshotAt = 0;
  private noDataIncidentActive = false;
  private noResponseIncidentActive = false;
  private readonly archivedEventMap = new Map<string, PowerQualityEvent>();

  readonly state = signal<LiveState | null>(null);
  readonly paused = signal(false);
  readonly pollingRateMs = signal(this.liveConfig.config().pollingSeconds * 1000);
  readonly rangeMode = signal<RangeMode>(this.liveConfig.config().defaultRange);
  readonly isLoading = signal(true);
  readonly isCatchingUp = signal(false);
  readonly lastPollAt = signal<string | null>(null);
  readonly lastDataAt = signal<string | null>(null);
  readonly consecutiveUnansweredRequests = signal(0);
  readonly diagnosticAlert = signal<DiagnosticAlert | null>(null);
  readonly diagnosticHistory = signal<DiagnosticArchiveEntry[]>([]);
  readonly archivedEvents = signal<PowerQualityEvent[]>([]);
  readonly noNewDataThresholdMs = computed(() => this.pollingRateMs() * 5);

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
    this.resetDiagnosticTracking();
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
    this.resetDiagnosticTracking();
    this.loadSnapshot(false);
  }

  dismissDiagnosticAlert(): void {
    this.diagnosticAlert.set(null);
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
        this.archiveEvents(snapshot.events);
        this.receivedState = next;
        this.lastSnapshotAt = Date.now();
        this.recordResponseSuccess(true);
        if (!this.paused()) this.state.set(structuredClone(next));
        this.isLoading.set(false);
        this.lastPollAt.set(new Date().toISOString());
        if (startPolling && !this.pollingSubscription) this.startPolling();
      }),
      catchError((error: unknown) => {
        this.isLoading.set(false);
        this.recordRequestFailure(error);
        if (startPolling && !this.pollingSubscription) this.startPolling();
        return EMPTY;
      }),
    ).subscribe();
  }

  private startPolling(): void {
    this.pollingSubscription = this.rateSubject.pipe(
      switchMap((rate) => timer(0, rate).pipe(
        // exhaustMap prevents a slow REST request from overlapping the next tick.
        exhaustMap(() => {
          this.checkForMissingData();
          if (!RANGE_CONFIG[this.rangeMode()].polling) {
            return this.api.getLastSeen().pipe(
              tap((heartbeat) => {
                this.recordResponseSuccess(false);
                this.acceptHeartbeat(heartbeat);
              }),
              catchError((error: unknown) => {
                this.recordRequestFailure(error);
                return EMPTY;
              }),
            );
          }
          const config = this.liveConfig.config();
          if (config.snapshotRefreshMinutes > 0 && Date.now() - this.lastSnapshotAt >= config.snapshotRefreshMinutes * 60_000) {
            this.loadSnapshot(false);
            return EMPTY;
          }
          const cursor = this.receivedState?.cursor;
          if (!cursor) {
            if (!this.isLoading()) this.loadSnapshot(false);
            return EMPTY;
          }
          return this.api.getUpdates(cursor).pipe(
            tap((delta) => this.acceptDelta(delta, 0)),
            catchError((error: unknown) => {
              this.recordRequestFailure(error);
              return EMPTY;
            }),
          );
        }),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe();
  }

  private acceptDelta(delta: LiveEnvelope, catchUpDepth: number): void {
    if (!RANGE_CONFIG[this.rangeMode()].polling) return;
    const current = this.receivedState;
    if (!current) return;

    const hasNewData = delta.cursor !== current.cursor
      || delta.voltage.length > 0
      || delta.events.length > 0
      || delta.unbalance.length > 0
      || delta.quality.length > 0;
    this.archiveEvents(delta.events);
    this.recordResponseSuccess(hasNewData);

    if (delta.cursorGapDetected) {
      const reloadSnapshot = this.liveConfig.config().sequenceGapAction === 'reload-snapshot';
      this.receivedState = {
        ...current,
        gapDetected: true,
        connection: 'error',
        errorMessage: reloadSnapshot
          ? 'Sequenzlücke erkannt – Snapshot wird neu geladen.'
          : 'Sequenzlücke erkannt – automatische Wiederherstellung ist deaktiviert.',
      };
      if (!this.paused()) this.state.set(structuredClone(this.receivedState));
      if (reloadSnapshot) {
        this.loadSnapshot(false);
      }
      return;
    }

    const cutoff = Date.now() - RANGE_CONFIG[this.rangeMode()].minutes * 60 * 1000;
    const voltage = this.mergeUnique(
      current.voltage,
      delta.voltage,
      (point) => `${point.timestamp}:${point.phase}`,
    ).filter((point) => Date.parse(point.timestamp) >= cutoff);
    const eventsById = new Map([...current.events, ...delta.events].map((event) => [event.id, event]));
    const events = [...eventsById.values()].filter((event) => Date.parse(event.timestamp) >= cutoff);
    const unbalance = this.mergeUnique(current.unbalance, delta.unbalance, (point) => point.timestamp)
      .filter((point) => Date.parse(point.timestamp) >= cutoff);
    const quality = this.mergeUnique(current.quality, delta.quality, (point) => point.timestamp)
      .filter((point) => Date.parse(point.timestamp) >= cutoff);

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
      const maxCatchUpRequests = this.liveConfig.config().maxCatchUpRequests;
      if (catchUpDepth >= maxCatchUpRequests) {
        this.isCatchingUp.set(false);
        this.receivedState = {
          ...this.receivedState,
          connection: 'error',
          errorMessage: `Catch-up-Limit von ${maxCatchUpRequests} Abrufen erreicht – Snapshot wird erneuert.`,
        };
        if (!this.paused()) this.state.set(structuredClone(this.receivedState));
        this.loadSnapshot(false);
        return;
      }
      this.isCatchingUp.set(true);
      queueMicrotask(() => this.catchUp(catchUpDepth + 1));
    } else {
      this.isCatchingUp.set(false);
    }
  }

  private acceptHeartbeat(heartbeat: { serverTime: string; lastSeen: string | null }): void {
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

  private catchUp(catchUpDepth: number): void {
    const cursor = this.receivedState?.cursor;
    if (!cursor) return;
    this.api.getUpdates(cursor).pipe(
      takeUntilDestroyed(this.destroyRef),
      tap((delta) => this.acceptDelta(delta, catchUpDepth)),
      catchError((error: unknown) => {
        this.isCatchingUp.set(false);
        this.recordRequestFailure(error);
        return EMPTY;
      }),
    ).subscribe();
  }

  private recordResponseSuccess(hasNewData: boolean): void {
    this.consecutiveUnansweredRequests.set(0);
    this.noResponseIncidentActive = false;
    this.resolveDiagnostics('server-unreachable');
    if (this.diagnosticAlert()?.kind === 'server-unreachable') this.diagnosticAlert.set(null);

    if (hasNewData) {
      this.lastDataAt.set(new Date().toISOString());
      this.noDataIncidentActive = false;
      this.resolveDiagnostics('no-new-data');
      if (this.diagnosticAlert()?.kind === 'no-new-data') this.diagnosticAlert.set(null);
      return;
    }

    this.checkForMissingData();
  }

  private recordRequestFailure(error: unknown): void {
    const failedRequests = this.consecutiveUnansweredRequests() + 1;
    this.consecutiveUnansweredRequests.set(failedRequests);
    const limit = this.liveConfig.config().unansweredRequestLimit;
    if (failedRequests < limit || this.noResponseIncidentActive) return;

    this.noResponseIncidentActive = true;
    const cause = this.describeError(error);
    const requestText = failedRequests === 1
      ? 'einen aufeinanderfolgenden Pollingabruf'
      : `${failedRequests} aufeinanderfolgende Pollingabrufe`;
    const message = `Die REST-API hat auf ${requestText} nicht geantwortet. Letzter Fehler: ${cause}`;
    const alert: DiagnosticAlert = {
      kind: 'server-unreachable',
      title: 'Keine Antwort vom API-Server',
      message,
      detectedAt: new Date().toISOString(),
    };
    this.diagnosticAlert.set(alert);
    this.archiveDiagnostic(alert);
    this.publishError(message);
  }

  private checkForMissingData(): void {
    if (!RANGE_CONFIG[this.rangeMode()].polling || this.consecutiveUnansweredRequests() > 0 || this.noDataIncidentActive) return;
    const lastDataAt = this.lastDataAt();
    if (!lastDataAt) return;
    const elapsedMs = Date.now() - Date.parse(lastDataAt);
    const thresholdMs = this.noNewDataThresholdMs();
    if (elapsedMs < thresholdMs) return;

    this.noDataIncidentActive = true;
    const alert: DiagnosticAlert = {
      kind: 'no-new-data',
      title: 'Keine neuen Live-Daten',
      message: `Die API antwortet, hat aber seit ${this.formatDuration(elapsedMs)} keine neuen Messdaten oder Ereignisse bereitgestellt. Der Grenzwert beträgt fünf Pollingintervalle (${this.formatDuration(thresholdMs)}).`,
      detectedAt: new Date().toISOString(),
    };
    this.diagnosticAlert.set(alert);
    this.archiveDiagnostic(alert);
  }

  private resetDiagnosticTracking(): void {
    this.consecutiveUnansweredRequests.set(0);
    this.lastDataAt.set(null);
    this.noDataIncidentActive = false;
    this.noResponseIncidentActive = false;
    this.diagnosticAlert.set(null);
  }

  private publishError(error: unknown): void {
    const message = this.describeError(error);
    if (this.receivedState) {
      this.receivedState = { ...this.receivedState, connection: 'error', errorMessage: message };
      if (!this.paused()) this.state.set(structuredClone(this.receivedState));
    }
  }

  private formatDuration(milliseconds: number): string {
    return `${(milliseconds / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
  }

  private describeError(error: unknown): string {
    if (typeof error === 'string' && error.trim()) return error;
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
    return 'REST-Abfrage ohne verwertbare Antwort';
  }

  private archiveEvents(events: PowerQualityEvent[]): void {
    if (!events.length) return;
    for (const event of events) this.archivedEventMap.set(event.id, event);
    const archived = [...this.archivedEventMap.values()]
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
      .slice(0, 2000);
    this.archivedEventMap.clear();
    for (const event of archived) this.archivedEventMap.set(event.id, event);
    this.archivedEvents.set(archived);
  }

  private archiveDiagnostic(alert: DiagnosticAlert): void {
    if (this.diagnosticHistory().some((entry) => entry.kind === alert.kind && entry.status === 'active')) return;
    const entry: DiagnosticArchiveEntry = {
      ...alert,
      id: `${alert.kind}-${Date.parse(alert.detectedAt)}`,
      status: 'active',
      resolvedAt: null,
    };
    this.diagnosticHistory.update((history) => [entry, ...history].slice(0, 500));
  }

  private resolveDiagnostics(kind: DiagnosticAlert['kind']): void {
    const resolvedAt = new Date().toISOString();
    this.diagnosticHistory.update((history) => history.map((entry) =>
      entry.kind === kind && entry.status === 'active'
        ? { ...entry, status: 'resolved', resolvedAt }
        : entry,
    ));
  }

  private mergeUnique<T>(current: T[], incoming: T[], keyOf: (value: T) => string): T[] {
    const values = new Map<string, T>();
    for (const value of current) values.set(keyOf(value), value);
    for (const value of incoming) values.set(keyOf(value), value);
    return [...values.values()];
  }
}
