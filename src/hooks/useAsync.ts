import { useCallback, useEffect, useRef, useState } from 'react'

export function useAsync<T>(factory: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const runId = useRef(0)
  const load = useCallback(() => {
    const id = ++runId.current
    setLoading(true); setError(null)
    factory().then(value => { if (id === runId.current) setData(value) }).catch(err => { if (id === runId.current) setError(err instanceof Error ? err.message : 'Unbekannter Fehler') }).finally(() => { if (id === runId.current) setLoading(false) })
  }, deps)
  useEffect(load, [load])
  return { data, loading, error, reload: load }
}
