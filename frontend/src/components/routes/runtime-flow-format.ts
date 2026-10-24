/** Visual-only formatting; never invents a rate for unknown evidence. */
export function formatFlowRate(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + 'K'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
}
