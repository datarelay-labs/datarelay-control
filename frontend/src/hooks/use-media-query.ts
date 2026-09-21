import { useEffect, useState } from 'react'

/** Subscribe to a CSS media query. Defaults to `false` before the first match (SSR-safe). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    function onChange(event: MediaQueryListEvent) {
      setMatches(event.matches)
    }
    setMatches(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Tailwind `md` breakpoint (768px) and above. */
export function useIsMdUp(): boolean {
  return useMediaQuery('(min-width: 768px)')
}
