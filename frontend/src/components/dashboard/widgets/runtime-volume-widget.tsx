import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { NAV_PATH } from '../../../config/nav-paths'
import { RuntimeChartCard } from '../../shell/runtime-chart-card'
import { cn } from '../../../lib/utils'
import { visualizationSummary } from '../../../api/visualizationMeta'
import type { DashboardOutcomeBucket, VisualizationMetaMap } from '../../../api/types/gdcApi'

const successFill = '#16a34a'
const failedFill = '#dc2626'
const rateLimitedFill = '#d97706'

function bucketTick(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(11, 16)
  } catch {
    return '?'
  }
}

export type RuntimeVolumeWidgetProps = {
  buckets: DashboardOutcomeBucket[]
  windowLabel: string
  loading: boolean
  visualizationMeta?: VisualizationMetaMap
}

export function RuntimeVolumeWidget({ buckets, windowLabel, loading, visualizationMeta }: RuntimeVolumeWidgetProps) {
  const chartData = buckets.map((b) => ({
    bucket: bucketTick(b.bucket_start),
    success: b.success,
    failed: b.failed,
    rateLimited: b.rate_limited,
  }))

  const empty = chartData.length === 0 || chartData.every((r) => r.success + r.failed + r.rateLimited === 0)
  const semanticSummary = visualizationSummary(visualizationMeta, 'dashboard.delivery_outcomes.bucket_count')

  return (
    <RuntimeChartCard
      className={cn('h-full min-h-0 lg:col-span-8', loading && 'opacity-80')}
      title={`Runtime volume (${windowLabel})`}
      subtitle={semanticSummary}
      actions={
        <Link
          to={NAV_PATH.runtime}
          className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
        >
          Runtime
        </Link>
      }
    >
      <div className="h-[268px] w-full min-w-0">
        {empty && !loading ? (
          <div className="flex h-full items-center justify-center text-[12px] text-slate-500 dark:text-gdc-muted">
            No volume data for this window.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -4, bottom: 4 }}>
              <XAxis
                dataKey="bucket"
                tick={{ fill: 'var(--gdc-chart-muted)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--gdc-chart-line)' }}
                tickLine={false}
              />
              <YAxis tick={{ fill: 'var(--gdc-chart-muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
              <Tooltip
                cursor={{ fill: 'rgb(148 163 184 / 0.06)' }}
                formatter={(value, name) => [`${value} events`, name]}
                labelFormatter={(label) => `Bucket ${label} · ${semanticSummary}`}
                contentStyle={{
                  borderRadius: 6,
                  border: '1px solid rgb(226 232 240 / 0.95)',
                  fontSize: 11,
                  boxShadow: '0 1px 2px rgb(0 0 0 / 0.05)',
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
                iconType="square"
                formatter={(value) => <span className="text-slate-600 dark:text-gdc-muted">{value}</span>}
              />
              <Bar dataKey="success" name="Success" stackId="a" fill={successFill} radius={[0, 0, 0, 0]} />
              <Bar dataKey="failed" name="Failed" stackId="a" fill={failedFill} radius={[0, 0, 0, 0]} />
              <Bar dataKey="rateLimited" name="Rate limited" stackId="a" fill={rateLimitedFill} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </RuntimeChartCard>
  )
}
