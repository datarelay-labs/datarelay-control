import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { RuntimeTimelineItem } from '../../api/types/gdcApi'
import { timelineItemsToRecentLogLines } from '../../api/runtimeTimelineAdapter'
import { setDisplayTimezoneCache } from '../../lib/display-timezone-cache'
import { StreamRecentEventsPanel } from './stream-recent-events-panel'

const sample = [{
  id: 1,
  created_at: '2026-10-10T18:00:00+09:00',
  level: 'INFO',
  status: 'SUCCESS',
  stage: 'route_send_success',
  message: 'Route delivery completed',
  latency_ms: 12,
}] as RuntimeTimelineItem[]

afterEach(() => {
  setDisplayTimezoneCache({ userTimezone: null, platformDefaultTimezone: null })
})

describe('Recent Events time basis in Stream UI', () => {
  for (const variant of ['compact', 'default'] as const) {
    it(`keeps the timezone visible in ${variant} timeline navigation`, () => {
      setDisplayTimezoneCache({ userTimezone: 'UTC' })
      render(
        <MemoryRouter>
          <StreamRecentEventsPanel
            streamId="42"
            backendStreamId={42}
            recentLogs={timelineItemsToRecentLogLines(sample)}
            runHistory={[]}
            logsHref="/logs?stream_id=42"
            variant={variant}
          />
        </MemoryRouter>,
      )
      const panel = screen.getByTestId('stream-recent-events-panel')
      expect(panel).toHaveTextContent('09:00:00 UTC')
    })
  }
})
