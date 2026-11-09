import { CalendarRange, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { fromLocalInput, toLocalInput } from '../lib/utils'
import { Button, Card, Field, Input } from './ui'

export interface DateRange { from: string; to: string }
export function defaultRange(hours = 24): DateRange { const to = new Date(); const from = new Date(to.getTime() - hours * 3600_000); return { from: from.toISOString(), to: to.toISOString() } }

export function FilterPanel({ children, range, onRange, onReset, compact = false }: { children?: ReactNode; range?: DateRange; onRange?: (range: DateRange) => void; onReset?: () => void; compact?: boolean }) {
  const [local, setLocal] = useState(range)
  useEffect(() => setLocal(range), [range?.from, range?.to])
  useEffect(() => {
    if (!local || !onRange) return
    const timer = setTimeout(() => onRange(local), 450)
    return () => clearTimeout(timer)
  }, [local?.from, local?.to])
  return <Card className="mb-5"><div className="flex flex-col gap-4 p-4 xl:flex-row xl:items-end"><div className="flex items-center gap-2 self-start pb-1 text-xs font-semibold uppercase tracking-wider text-slate-500 xl:mr-2 xl:self-center"><SlidersHorizontal className="h-4 w-4 text-brand" />Filter</div><div className={compact ? 'contents' : 'contents'}>{children}</div>{range && local && <><Field label="Von" className="min-w-[190px] flex-1"><div className="relative"><CalendarRange className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" /><Input className="pl-9" type="datetime-local" value={toLocalInput(new Date(local.from))} onChange={e => setLocal({ ...local, from: fromLocalInput(e.target.value) })} /></div></Field><Field label="Bis" className="min-w-[190px] flex-1"><div className="relative"><CalendarRange className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" /><Input className="pl-9" type="datetime-local" value={toLocalInput(new Date(local.to))} onChange={e => setLocal({ ...local, to: fromLocalInput(e.target.value) })} /></div></Field></>}{onReset && <Button variant="secondary" onClick={onReset}><RotateCcw className="h-4 w-4" />Zurücksetzen</Button>}</div></Card>
}
