import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { EChartsOption } from 'echarts';
import { finalize } from 'rxjs';
import { LiveStore, RANGE_CONFIG } from './core/live.store';
import { EventType, Phase, QualityMetric, RangeMode } from './core/live.models';
import { ApiConnectionConfig, DEFAULT_API_CONFIG, LiveConfigService } from './core/live-config.service';
import { LiveApiService } from './core/live-api.service';
import { EchartComponent } from './shared/echart.component';
import { PhasorComponent } from './shared/phasor.component';

const PHASE_COLORS: Record<Phase, string> = { L1: '#38bdf8', L2: '#a78bfa', L3: '#2dd4bf' };
const PHASE_SYMBOLS: Record<Phase, 'circle' | 'diamond' | 'triangle'> = { L1: 'circle', L2: 'diamond', L3: 'triangle' };
const EVENT_COLORS: Record<EventType, string> = {
  'Voltage Dip': '#f59e0b',
  'Voltage Swell': '#f05252',
  'Voltage Interruption': '#ef4444',
  'Rapid Voltage Change': '#8b5cf6',
  'Spannungstransient': '#0ea5e9',
};

@Component({
  selector: 'pqm-root',
  standalone: true,
  imports: [FormsModule, EchartComponent, PhasorComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css', './app.overrides.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  readonly store = inject(LiveStore);
  readonly liveConfig = inject(LiveConfigService);
  private readonly liveApi = inject(LiveApiService);
  readonly activeView = signal<'dashboard' | 'configuration'>('dashboard');
  readonly configMessage = signal<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  readonly testingConnection = signal(false);
  configDraft: ApiConnectionConfig = { ...this.liveConfig.config() };
  readonly rangeConfig = RANGE_CONFIG;
  readonly rangeModes: RangeMode[] = ['live', '15m', '1h', '24h'];
  readonly eventTypes: EventType[] = ['Voltage Dip', 'Voltage Swell', 'Voltage Interruption', 'Rapid Voltage Change', 'Spannungstransient'];
  readonly qualityMetrics: Array<{ value: QualityMetric; label: string }> = [
    { value: 'frequency', label: 'Frequenz' },
    { value: 'pst', label: 'Pst-Flicker' },
    { value: 'plt', label: 'Plt-Flicker' },
    { value: 'longTermRms', label: 'Langzeit-RMS' },
  ];
  readonly eventType = signal<EventType | 'ALL'>('ALL');
  readonly eventPhase = signal<Phase | 'ALL'>('ALL');
  readonly thdsPhase = signal<Phase | 'ALL'>('ALL');
  readonly qualityMetric = signal<QualityMetric>('frequency');
  readonly showDetail = signal(false);
  pollingSeconds = 2;
  pollingValidation = '';

  readonly filteredEvents = computed(() => (this.store.state()?.events ?? []).filter((event) =>
    (this.eventType() === 'ALL' || event.type === this.eventType()) &&
    (this.eventPhase() === 'ALL' || event.phase === this.eventPhase()),
  ));

  readonly voltageOption = computed<EChartsOption>(() => {
    const state = this.store.state();
    const points = state?.voltage ?? [];
    const events = this.filteredEvents();
    const eventLines = events.map((event) => ({
      name: `${event.type} · ${event.phase}`,
      xAxis: event.timestamp,
      label: { show: false },
      lineStyle: { color: EVENT_COLORS[event.type], type: 'dotted' as const, opacity: .7 },
    }));
    const eventAreas = events.map((event) => ([
      { xAxis: event.timestamp, itemStyle: { color: EVENT_COLORS[event.type], opacity: .08 } },
      { xAxis: new Date(Date.parse(event.timestamp) + Math.max(event.durationMs, 2000)).toISOString() },
    ]));
    const series = (['L1', 'L2', 'L3'] as Phase[]).flatMap((phase, index) => {
      const phasePoints = points.filter((point) => point.phase === phase);
      return [
        {
          name: `${phase} Minimum`, type: 'line' as const, stack: `band-${phase}`, showSymbol: false, silent: true,
          animation: false, tooltip: { show: false }, lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 },
          data: phasePoints.map((point) => [point.timestamp, point.rmsMin]),
        },
        {
          name: `${phase} Min/Max`, type: 'line' as const, stack: `band-${phase}`, showSymbol: false, silent: true,
          animation: false, tooltip: { show: false }, lineStyle: { opacity: 0 }, areaStyle: { color: PHASE_COLORS[phase], opacity: .10 },
          data: phasePoints.map((point) => [point.timestamp, point.rmsMax - point.rmsMin]),
        },
        {
          name: phase, type: 'line' as const, showSymbol: false, smooth: false, animation: false,
          lineStyle: { width: 1.8, color: PHASE_COLORS[phase] }, itemStyle: { color: PHASE_COLORS[phase] },
          data: phasePoints.map((point) => [point.timestamp, point.rmsAvg]),
          ...(index === 0 ? {
            markLine: {
              silent: true, symbol: 'none', label: { color: '#a9b8ca', formatter: ({ name }: { name?: string }) => name ?? '' },
              data: [
                { name: 'Swell-Grenze', yAxis: state?.thresholds.swellVoltage ?? 253, lineStyle: { color: '#f05252', type: 'dashed' as const } },
                { name: 'Udin', yAxis: state?.thresholds.nominalVoltage ?? 230, lineStyle: { color: '#8ba0b8', type: 'dotted' as const } },
                { name: 'Dip-Grenze', yAxis: state?.thresholds.dipVoltage ?? 207, lineStyle: { color: '#f59e0b', type: 'dashed' as const } },
                ...eventLines,
              ],
            },
            markArea: { silent: true, label: { show: false }, data: eventAreas },
          } : {}),
        },
      ];
    });
    const option = this.timeChartBase(series, 'Spannung [V]', 175, 265);
    option.legend = { top: 5, data: ['L1', 'L2', 'L3'], textStyle: { color: '#cbd5e1' } };
    return option;
  });

  readonly eventOption = computed<EChartsOption>(() => {
    const events = this.filteredEvents();
    const categories: EventType[] = ['Voltage Dip', 'Voltage Swell', 'Voltage Interruption', 'Rapid Voltage Change', 'Spannungstransient'];
    const eventGroups = new Map<string, number>();
    for (const event of events) {
      const key = `${event.timestamp}-${event.type}`;
      eventGroups.set(key, (eventGroups.get(key) ?? 0) + 1);
    }
    return {
      backgroundColor: 'transparent',
      animation: false,
      grid: { left: 142, right: 26, top: 22, bottom: 48 },
      tooltip: {
        trigger: 'item',
        formatter: (params: unknown) => {
          const value = (params as { value: [string, string, string, number] }).value;
          return `${value[1]} · ${value[2]}<br>${this.formatTime(value[0])} · ${value[3]} ms`;
        },
      },
      xAxis: {
        type: 'time',
        axisLabel: { color: '#8ea1b8', hideOverlap: true },
        axisLine: { lineStyle: { color: '#44546a' } },
        splitLine: { show: true, lineStyle: { color: '#223249', type: 'dashed' } },
      },
      yAxis: {
        type: 'category',
        data: categories,
        axisLabel: { color: '#c6d1df', width: 126, overflow: 'truncate' },
        axisLine: { lineStyle: { color: '#44546a' } },
        splitLine: { show: true, lineStyle: { color: '#223249' } },
      },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 8, borderColor: '#33445c', fillerColor: 'rgba(56,189,248,.12)' }],
      series: [{
        name: 'PQ-Ereignisse',
        type: 'scatter',
        symbolSize: (value: unknown) => Math.min(30, 23 + Math.log10(Math.max(1, (value as [string, string, string, number])[3])) * 2),
        data: events.map((event) => {
          const isSimultaneous = (eventGroups.get(`${event.timestamp}-${event.type}`) ?? 0) > 1;
          const offset: Record<Phase, [number, number]> = { L1: [-17, 0], L2: [0, 0], L3: [17, 0] };
          return {
            value: [event.timestamp, event.type, event.phase, event.durationMs],
            symbol: PHASE_SYMBOLS[event.phase],
            symbolOffset: isSimultaneous ? offset[event.phase] : [0, 0],
            label: {
              show: true,
              position: 'inside' as const,
              formatter: event.phase,
              color: '#ffffff',
              fontSize: 9,
              fontWeight: 800,
              align: 'center' as const,
              verticalAlign: 'middle' as const,
              distance: 0,
              offset: event.phase === 'L3' ? [0, 3] : [0, 0],
            },
            itemStyle: { color: EVENT_COLORS[event.type], borderColor: '#ffffff', borderWidth: 1 },
          };
        }),
      }],
    };
  });

  readonly thdsOption = computed<EChartsOption>(() => {
    const points = this.store.state()?.voltage ?? [];
    const series = (['L1', 'L2', 'L3'] as Phase[]).filter((phase) => this.thdsPhase() === 'ALL' || this.thdsPhase() === phase).map((phase) => ({
      name: phase,
      type: 'line' as const,
      showSymbol: false,
      animation: false,
      lineStyle: { width: 1.6, color: PHASE_COLORS[phase] },
      itemStyle: { color: PHASE_COLORS[phase] },
      areaStyle: { color: `${PHASE_COLORS[phase]}12` },
      data: points.filter((p) => p.phase === phase).map((p) => [p.timestamp, p.voltageThdsPercent]),
    }));
    return this.timeChartBase(series, 'THDS [%]', 0, 5);
  });

  readonly qualityOption = computed<EChartsOption>(() => {
    const points = this.store.state()?.quality ?? [];
    const metric = this.qualityMetric();
    const config: Record<QualityMetric, { label: string; unit: string; color: string; min: number; max: number }> = {
      frequency: { label: 'Frequenz', unit: 'Hz', color: '#34d399', min: 49.8, max: 50.2 },
      pst: { label: 'Pst-Flicker', unit: 'Pst', color: '#f59e0b', min: 0, max: 1.5 },
      plt: { label: 'Plt-Flicker', unit: 'Plt', color: '#f472b6', min: 0, max: 1.2 },
      longTermRms: { label: 'Langzeit-RMS', unit: 'V', color: '#38bdf8', min: 225, max: 235 },
    };
    const selected = config[metric];
    const option = this.timeChartBase([{
      name: selected.label,
      type: 'line',
      showSymbol: false,
      animation: false,
      lineStyle: { width: 2, color: selected.color },
      itemStyle: { color: selected.color },
      areaStyle: { color: `${selected.color}12` },
      data: points.map((point) => [point.timestamp,
        metric === 'frequency' ? point.frequencyHz :
          metric === 'pst' ? point.pst :
            metric === 'plt' ? point.plt : point.longTermRms,
      ]),
      markLine: metric === 'frequency' ? {
        silent: true,
        symbol: 'none',
        label: { color: '#a9b8ca', formatter: '50 Hz' },
        data: [{ yAxis: 50, lineStyle: { color: '#8ba0b8', type: 'dashed' } }],
      } : undefined,
    }], `${selected.label} [${selected.unit}]`, selected.min, selected.max);
    option.legend = { show: false };
    return option;
  });

  readonly unbalanceOption = computed<EChartsOption>(() => {
    const points = this.store.state()?.unbalance ?? [];
    return this.timeChartBase([
      { name: 'Gegensystem', type: 'line', showSymbol: false, animation: false, lineStyle: { color: '#f59e0b', width: 2 }, itemStyle: { color: '#f59e0b' }, data: points.map((p) => [p.timestamp, p.negativePercent]) },
      { name: 'Nullsystem', type: 'line', showSymbol: false, animation: false, lineStyle: { color: '#f472b6', width: 2 }, itemStyle: { color: '#f472b6' }, data: points.map((p) => [p.timestamp, p.zeroPercent]) },
    ], 'Unsymmetrie [%]', 0, 2.5);
  });

  readonly eventCounts = computed(() => {
    const counts = new Map<EventType, number>();
    for (const event of this.filteredEvents()) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    return counts;
  });

  readonly latestThds = computed(() => {
    const values = (this.store.state()?.voltage ?? [])
      .filter((point) => this.thdsPhase() === 'ALL' || point.phase === this.thdsPhase())
      .slice(-3).map((point) => point.voltageThdsPercent);
    return values.length ? Math.max(...values) : 0;
  });

  readonly detailStats = computed(() => (['L1', 'L2', 'L3'] as Phase[]).map((phase) => {
    const points = (this.store.state()?.voltage ?? []).filter((point) => point.phase === phase);
    const average = points.length ? points.reduce((sum, point) => sum + point.rmsAvg, 0) / points.length : 0;
    return {
      phase,
      average,
      minimum: points.length ? Math.min(...points.map((point) => point.rmsMin)) : 0,
      maximum: points.length ? Math.max(...points.map((point) => point.rmsMax)) : 0,
      flagged: points.filter((point) => point.isFlagged).length,
      samples: points.length,
    };
  }));

  applyPollingRate(): void {
    const value = Number(this.pollingSeconds);
    if (!Number.isFinite(value) || value < 0.5 || value > 30) {
      this.pollingValidation = 'Bitte 0,5 bis 30 Sekunden eingeben.';
      return;
    }
    this.pollingValidation = '';
    this.store.setPollingRate(value);
    this.pollingSeconds = this.store.pollingRateMs() / 1000;
  }

  openView(view: 'dashboard' | 'configuration'): void {
    this.activeView.set(view);
    if (view === 'configuration') {
      this.configDraft = { ...this.liveConfig.config() };
      this.configMessage.set(null);
    }
  }

  saveApiConfiguration(): void {
    if (!this.configDraft.demoMode && !this.configDraft.baseUrl.trim()) {
      this.configMessage.set({ tone: 'error', text: 'Für den Produktivbetrieb ist eine API-Basis-URL erforderlich.' });
      return;
    }
    if (!this.configDraft.meterId.trim()) {
      this.configMessage.set({ tone: 'error', text: 'Eine Messgerät-ID ist erforderlich.' });
      return;
    }
    this.liveConfig.update({ ...this.configDraft });
    this.configDraft = { ...this.liveConfig.config() };
    this.pollingSeconds = this.configDraft.pollingSeconds;
    this.store.setPollingRate(this.configDraft.pollingSeconds);
    this.store.reload();
    this.configMessage.set({ tone: 'success', text: 'Konfiguration übernommen. Der Live-Client wurde neu gestartet.' });
  }

  resetApiConfiguration(): void {
    this.liveConfig.reset();
    this.configDraft = { ...DEFAULT_API_CONFIG };
    this.pollingSeconds = this.configDraft.pollingSeconds;
    this.store.setPollingRate(this.configDraft.pollingSeconds);
    this.store.reload();
    this.configMessage.set({ tone: 'info', text: 'Standardkonfiguration und Demoquelle wurden wiederhergestellt.' });
  }

  testApiConnection(): void {
    this.testingConnection.set(true);
    this.configMessage.set({ tone: 'info', text: 'Verbindung wird geprüft …' });
    this.liveApi.testConnection({ ...this.configDraft }).pipe(
      finalize(() => this.testingConnection.set(false)),
    ).subscribe({
      next: (result) => this.configMessage.set({ tone: 'success', text: `Verbindung erfolgreich · ${result.latencyMs} ms` }),
      error: (error: unknown) => this.configMessage.set({ tone: 'error', text: `Verbindung fehlgeschlagen: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}` }),
    });
  }

  count(type: EventType): number { return this.eventCounts().get(type) ?? 0; }
  phaseVoltage(phase: Phase): number { return this.store.latestVoltage().get(phase) ?? 0; }
  formatTime(value: string | null | undefined): string {
    if (!value) return '–';
    return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
  }
  formatRate(milliseconds: number): string { return (milliseconds / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

  private timeChartBase(series: unknown[], yName: string, min: number, max: number): EChartsOption {
    return {
      backgroundColor: 'transparent',
      animation: false,
      color: Object.values(PHASE_COLORS),
      grid: { left: 62, right: 34, top: 48, bottom: 54 },
      legend: { top: 5, textStyle: { color: '#cbd5e1' } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross', label: { backgroundColor: '#25364d' } } },
      xAxis: {
        type: 'time',
        axisLabel: { color: '#8ea1b8', hideOverlap: true },
        axisLine: { lineStyle: { color: '#44546a' } },
        splitLine: { show: true, lineStyle: { color: '#223249', type: 'dashed' } },
      },
      yAxis: {
        type: 'value', name: yName, min, max,
        nameTextStyle: { color: '#8ea1b8', align: 'right' },
        axisLabel: { color: '#8ea1b8' },
        axisLine: { show: true, lineStyle: { color: '#44546a' } },
        splitLine: { show: true, lineStyle: { color: '#2a3b52' } },
      },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 8, borderColor: '#33445c', fillerColor: 'rgba(56,189,248,.12)' }],
      series: series as EChartsOption['series'],
    };
  }
}
