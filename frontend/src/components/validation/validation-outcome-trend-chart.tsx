import { useMemo } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ValidationOutcomeTrendBucket } from '../../api/types/gdcApi'

export function ValidationOutcomeTrendChart({ buckets }: { buckets: ValidationOutcomeTrendBucket[] }) {
  const data = useMemo(
    () =>
      buckets.map((b) => ({
        ...b,
        label: new Date(b.bucket_start).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' }),
      })),
    [buckets],
  )
  if (!data.length) {
    return <p className="text-[11px] text-slate-500 dark:text-gdc-muted">No runner_summary samples in the last 24h.</p>
  }
  return (
    <div className="h-48 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-gdc-divider" />
          <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="var(--gdc-chart-muted)" />
          <YAxis width={28} tick={{ fontSize: 9 }} stroke="var(--gdc-chart-muted)" allowDecimals={false} />
          <Tooltip contentStyle={{ fontSize: 11 }} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          <Line type="monotone" dataKey="pass_count" name="PASS" stroke="#10b981" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="fail_count" name="FAIL" stroke="#f43f5e" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="warn_count" name="WARN" stroke="#f59e0b" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
