/** Visual-only formatting; never invents a rate for unknown evidence. */
export function formatFlowRate(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value >= 1_000_000) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value / 1_000_000) + 'M'
  if (value >= 1000) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value / 1000) + 'K'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)
}
