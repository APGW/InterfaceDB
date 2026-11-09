import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X, LoaderCircle, Inbox, TriangleAlert } from 'lucide-react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { cn } from '../lib/utils'

export function Button({ className, variant = 'primary', size = 'md', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'icon' }) {
  return <button className={cn('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50', size === 'sm' ? 'h-8 px-3 text-xs' : size === 'icon' ? 'h-9 w-9' : 'h-10 px-4 text-sm', variant === 'primary' && 'bg-brand text-white shadow-sm hover:bg-[#187e99]', variant === 'secondary' && 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200', variant === 'ghost' && 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800', variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700', className)} {...props} />
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn('card', className)} {...props} /> }
export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return <div className={cn('flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 dark:border-slate-800', className)}><div><h2 className="section-title">{title}</h2>{description && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>}</div>{action}</div>
}
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn('p-5', className)} {...props} /> }

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold', tone === 'neutral' && 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300', tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300', tone === 'warning' && 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300', tone === 'danger' && 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300', tone === 'info' && 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900 dark:bg-cyan-950 dark:text-cyan-300', className)}>{children}</span>
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) { return <select className={cn('control', className)} {...props}>{children}</select> }
export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) { return <label className={className}><span className="label">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}</label> }
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...props} className={cn('control', props.className)} /> }

export function LoadingState({ label = 'Daten werden geladen …' }: { label?: string }) { return <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-slate-500"><LoaderCircle className="h-6 w-6 animate-spin text-brand" />{label}</div> }
export function EmptyState({ title = 'Keine Daten vorhanden', text = 'Für die gewählten Filter wurden keine Einträge gefunden.' }: { title?: string; text?: string }) { return <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center"><Inbox className="mb-3 h-8 w-8 text-slate-300" /><p className="font-medium text-slate-700 dark:text-slate-200">{title}</p><p className="mt-1 max-w-sm text-sm text-slate-500">{text}</p></div> }
export function ErrorState({ message }: { message: string }) { return <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center"><TriangleAlert className="mb-3 h-8 w-8 text-red-500" /><p className="font-medium text-red-700 dark:text-red-300">Daten konnten nicht geladen werden</p><p className="mt-1 max-w-xl text-sm text-slate-500">{message}</p></div> }

export function Dialog({ open, onOpenChange, title, description, children, size = 'md' }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; size?: 'md' | 'lg' | 'xl' }) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-[2px] data-[state=open]:animate-in" />
      <DialogPrimitive.Content className={cn('fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900', size === 'md' && 'max-w-xl', size === 'lg' && 'max-w-3xl', size === 'xl' && 'max-w-5xl')}>
        <div className="sticky top-0 z-10 flex items-start justify-between gap-6 border-b border-slate-100 bg-white px-6 py-5 dark:border-slate-800 dark:bg-slate-900"><div><DialogPrimitive.Title className="text-lg font-semibold text-slate-900 dark:text-white">{title}</DialogPrimitive.Title>{description && <DialogPrimitive.Description className="mt-1 text-sm text-slate-500">{description}</DialogPrimitive.Description>}</div><DialogPrimitive.Close asChild><Button variant="ghost" size="icon" aria-label="Schließen"><X className="h-4 w-4" /></Button></DialogPrimitive.Close></div>
        <div className="p-6">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <div className="flex items-center justify-between gap-4 py-3 text-sm text-slate-500"><span>{total ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} von ${total}` : '0 Einträge'}</span><div className="flex gap-2"><Button variant="secondary" size="sm" disabled={page <= 0} onClick={() => onPage(page - 1)}>Zurück</Button><Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Weiter</Button></div></div>
}
