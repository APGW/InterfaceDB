import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }

const berlinDateTime = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
const berlinDate = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })

export const formatDateTime = (value: string | number | Date) => berlinDateTime.format(new Date(value))
export const formatDate = (value: string | number | Date) => berlinDate.format(new Date(value))
export const formatNumber = (value: number, digits = 2) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
export const formatDuration = (ms: number) => ms < 1000 ? `${ms} ms` : `${formatNumber(ms / 1000, 2)} s`
export const toLocalInput = (date: Date) => {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}
export const fromLocalInput = (value: string) => new Date(value).toISOString()

export const levelLabel: Record<string, string> = {
  BASIC: 'Basic · ca. 200 ms', SHORT_TERM: 'Short Term · ca. 3 s', TEN_MINUTE: 'Ten Minute · 10 min', TWO_HOUR: 'Two Hour · 2 h',
}
export const eventLabel: Record<string, string> = {
  VOLTAGE_DIP: 'Voltage Dip', VOLTAGE_SWELL: 'Voltage Swell', VOLTAGE_INTERRUPTION: 'Voltage Interruption',
  RAPID_VOLTAGE_CHANGE: 'Rapid Voltage Change', VOLTAGE_TRANSIENT: 'Spannungstransient',
}
export const stateLabel: Record<string, string> = { INIT: 'Initialisierung', RUNNING: 'Betriebsbereit', MEASURING: 'Messung aktiv', ERROR: 'Fehler', MAINTENANCE: 'Wartung' }

export function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const keys = Object.keys(rows[0])
  const escape = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`
  const csv = [keys.map(escape).join(';'), ...rows.map(row => keys.map(key => escape(row[key])).join(';'))].join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url)
}

export function relativeAge(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (minutes < 2) return 'gerade eben'
  if (minutes < 60) return `vor ${minutes} Min.`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `vor ${hours} Std.` : `vor ${Math.floor(hours / 24)} T.`
}
