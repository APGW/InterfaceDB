import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';

@Component({
  selector: 'pqm-echart',
  standalone: true,
  template: '<div #host class="chart-host" role="img" [attr.aria-label]="ariaLabel"></div>',
  styles: [':host,.chart-host{display:block;width:100%;height:100%;min-height:260px}'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EchartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) option: EChartsOption = {};
  @Input() ariaLabel = 'Diagramm';
  @ViewChild('host', { static: true }) private readonly host!: ElementRef<HTMLDivElement>;
  private chart?: ECharts;
  private observer?: ResizeObserver;

  ngAfterViewInit(): void {
    this.chart = echarts.init(this.host.nativeElement, undefined, { renderer: 'canvas' });
    this.chart.setOption(this.option, true);
    this.observer = new ResizeObserver(() => this.chart?.resize());
    this.observer.observe(this.host.nativeElement);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['option'] && this.chart) this.chart.setOption(this.option, true);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.chart?.dispose();
  }
}
