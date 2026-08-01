import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One loading pattern for every view, so every view gets loading, empty and
 * error states for free.
 *
 * `status` is 'loading' on the first fetch, 'refreshing' when we already have
 * data and are re-fetching (so the screen doesn't blank out mid-shift), then
 * 'ready' or 'error'. On error we keep the last good data around — a failed
 * refresh should not erase the record from the screen.
 */
export function useResource(load) {
  const [state, setState] = useState({
    status: 'loading',
    data: null,
    error: null,
  })
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(async () => {
    setState((prev) => ({
      status: prev.data === null ? 'loading' : 'refreshing',
      data: prev.data,
      error: null,
    }))
    try {
      const data = await load()
      if (alive.current) setState({ status: 'ready', data, error: null })
      return data
    } catch (error) {
      if (alive.current) {
        setState((prev) => ({ status: 'error', data: prev.data, error }))
      }
      return null
    }
  }, [load])

  useEffect(() => {
    reload()
  }, [reload])

  return { ...state, reload }
}
