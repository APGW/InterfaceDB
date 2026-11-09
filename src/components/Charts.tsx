import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, ScatterChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
import { useApp } from '../state/AppContext'

const palette = ['#2296B5', '#6E56CF', '#F59E0B', '#10B981', '#EF4444']
echarts.use([BarChart, LineChart, ScatterChart, DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, MarkPointComponent, TooltipComponent, CanvasRenderer])

export function Chart({ option, height = 300, onEvents, className }: { option: EChartsOption; height?: number; onEvents?: Record<string, (params: unknown) => void>; className?: string }) {
  const { darkMode } = useApp()
  const base: EChartsOption = {
    animationDuration: 500,
    color: palette,
    textStyle: { fontFamily: 'Inter, Segoe UI, sans-serif', color: darkMode ? '#94A3B8' : '#64748B' },
    tooltip: { trigger: 'axis', backgroundColor: darkMode ? '#172033' : '#fff', borderColor: darkMode ? '#334155' : '#E2E8F0', textStyle: { color: darkMode ? '#E2E8F0' : '#334155' }, extraCssText: 'box-shadow: 0 8px 24px rgba(15,23,42,.12); border-radius: 8px;' },
    legend: { textStyle: { color: darkMode ? '#94A3B8' : '#64748B' } },
    grid: { left: 54, right: 28, top: 46, bottom: 48 },
    ...option,
  }
  return <ReactEChartsCore echarts={echarts} className={className} option={base} theme={darkMode ? 'dark' : undefined} style={{ height, width: '100%' }} notMerge lazyUpdate onEvents={onEvents} />
}

export const timeAxis = { type: 'time' as const, axisLine: { lineStyle: { color: '#CBD5E1' } }, splitLine: { show: false }, axisLabel: { hideOverlap: true } }
export const valueAxis = (name?: string) => ({ type: 'value' as const, name, nameTextStyle: { padding: [0, 0, 8, 0] }, splitLine: { lineStyle: { color: '#E2E8F0', opacity: .6 } }, scale: true })
export const zoom = [{ type: 'inside' as const }, { type: 'slider' as const, height: 18, bottom: 8 }]
