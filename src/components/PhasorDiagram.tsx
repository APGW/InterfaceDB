import { formatNumber } from '../lib/utils'

export interface PhasorVector {
  label: string
  magnitude: number
  angleDeg: number
  color: string
  dashed?: boolean
}

interface Props {
  vectors: PhasorVector[]
  unit: string
  magnitudeDigits?: number
  title?: string
}

const center = 160
const radius = 116

export function PhasorDiagram({ vectors, unit, magnitudeDigits = 1, title = 'Zeigerdiagramm' }: Props) {
  const maxMagnitude = Math.max(...vectors.map(vector => Math.abs(vector.magnitude)), 1)
  const scale = radius / maxMagnitude
  return <div className="rounded-xl border border-slate-100 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
    <div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3><span className="text-[10px] uppercase tracking-wider text-slate-400">Betrag ∠ Winkel</span></div>
    <svg viewBox="0 0 320 320" className="mx-auto block w-full max-w-[360px]" role="img" aria-label={`${title} mit ${vectors.length} Zeigern`}>
      <rect x="0" y="0" width="320" height="320" rx="16" className="fill-slate-50 dark:fill-slate-950" />
      {[.33, .66, 1].map(factor => <circle key={factor} cx={center} cy={center} r={radius * factor} fill="none" className="stroke-slate-200 dark:stroke-slate-700" strokeWidth="1" strokeDasharray={factor === 1 ? undefined : '4 5'} />)}
      <line x1={center - radius - 12} y1={center} x2={center + radius + 12} y2={center} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1" />
      <line x1={center} y1={center - radius - 12} x2={center} y2={center + radius + 12} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1" />
      <text x={center + radius + 15} y={center + 4} className="fill-slate-400 text-[10px]">0°</text>
      <text x={center - 8} y={center - radius - 17} className="fill-slate-400 text-[10px]">90°</text>
      <text x={center - radius - 30} y={center + 4} className="fill-slate-400 text-[10px]">180°</text>
      <text x={center - 12} y={center + radius + 23} className="fill-slate-400 text-[10px]">−90°</text>
      {vectors.map((vector, index) => {
        const radians = vector.angleDeg * Math.PI / 180
        const length = Math.abs(vector.magnitude) * scale
        const x = center + Math.cos(radians) * length
        const y = center - Math.sin(radians) * length
        const arrowSize = 8
        const leftX = x - Math.cos(radians - .55) * arrowSize
        const leftY = y + Math.sin(radians - .55) * arrowSize
        const rightX = x - Math.cos(radians + .55) * arrowSize
        const rightY = y + Math.sin(radians + .55) * arrowSize
        const labelX = x + Math.cos(radians) * 13
        const labelY = y - Math.sin(radians) * 13
        return <g key={`${vector.label}-${index}`}>
          <line x1={center} y1={center} x2={x} y2={y} stroke={vector.color} strokeWidth="3" strokeLinecap="round" strokeDasharray={vector.dashed ? '7 5' : undefined} />
          <polygon points={`${x},${y} ${leftX},${leftY} ${rightX},${rightY}`} fill={vector.color} />
          <circle cx={center} cy={center} r="3.5" fill={vector.color} />
          <text x={labelX} y={labelY} fill={vector.color} textAnchor={Math.cos(radians) < -.2 ? 'end' : Math.cos(radians) > .2 ? 'start' : 'middle'} dominantBaseline="middle" className="text-[11px] font-semibold">{vector.label}</text>
        </g>
      })}
    </svg>
    <div className="mt-2 grid gap-2 sm:grid-cols-3">{vectors.map((vector, index) => <div key={`${vector.label}-legend-${index}`} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800"><div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: vector.color }} /><span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{vector.label}</span></div><p className="mt-1 font-mono text-[11px] text-slate-500">{formatNumber(vector.magnitude, magnitudeDigits)} {unit} ∠ {formatNumber(vector.angleDeg, 1)}°</p></div>)}</div>
  </div>
}
