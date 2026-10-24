import { expect, test } from '@playwright/test'

/**
 * Visual fixture verifies actual Chromium rendering of the production
 * topology/inspector, not live gateway delivery or production acceptance.
 */
for (const [width, height] of [[1920, 1080], [1440, 900]] as const) {
  test('desktop ' + width + 'x' + height + ': real Flow nodes, luminous edges and usable inspector', async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height })
    await page.goto('/e2e/fixtures/routing-flow-visual.html?scenario=healthy')
    await expect(page.getByTestId('visual-fixture-only')).toContainText('NOT LIVE TRAFFIC')
    await expect(page.getByTestId('runtime-flow-card-source')).toHaveCount(1)
    await expect(page.getByTestId('runtime-flow-card-stream')).toHaveCount(1)
    await expect(page.getByTestId('runtime-flow-card-route')).toHaveCount(3)
    await expect(page.getByTestId('runtime-flow-card-destination')).toHaveCount(3)
    await expect(page.locator('.control-runtime-flow-glow')).toHaveCount(3)
    await expect(page.locator('.control-runtime-flow-particles')).toHaveCount(3)

    await page.getByTestId('runtime-flow-card-route').first().click()
    const inspector = page.getByTestId('runtime-data-flow-inspector')
    await expect(inspector).toContainText('Route #12')
    await expect(inspector).toContainText('12.4')
    await expect(inspector).toContainText('receiver receipt not verified')
    await expect(inspector.getByRole('link', { name: 'Inspect Route' }))
      .toHaveAttribute('href', '/routes/12/edit')

    const layout = await page.evaluate(() => {
      const canvas = document.querySelector('.control-runtime-flow-canvas')?.getBoundingClientRect()
      const panel = document.querySelector('.control-runtime-flow-inspector')?.getBoundingClientRect()
      const route = document.querySelector('[data-testid="runtime-flow-card-route"]')?.getBoundingClientRect()
      return {
        canvasWidth: canvas?.width ?? 0,
        inspectorRight: panel?.right ?? 0,
        nodeWidth: route?.width ?? 0,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      }
    })
    expect(layout.canvasWidth).toBeGreaterThan(900)
    expect(layout.nodeWidth).toBeGreaterThan(175)
    expect(layout.inspectorRight).toBeLessThanOrEqual(width + 1)
    expect(layout.horizontalOverflow).toBe(false)
    await testInfo.attach('routing-flow-desktop-'+width, {
      body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
      contentType: 'image/png',
    })
  })
}

test('stale snapshot and reduced-motion never fake active glowing delivery', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/e2e/fixtures/routing-flow-visual.html?scenario=stale')
  await expect(page.getByTestId('runtime-flow-card-route')).toHaveCount(3)
  await expect(page.getByTestId('runtime-data-flow-evidence')).toContainText('stale')
  await expect(page.locator('.control-runtime-flow-glow')).toHaveCount(0)
  await expect(page.locator('.control-runtime-flow-particles')).toHaveCount(0)
  await expect(page.getByText(/receiver status not implied/)).toBeVisible()
})


for (const width of [1280, 1024, 640]) {
  test('zoom-equivalent viewport ' + width + ' keeps the graph and Inspector accessible', async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/e2e/fixtures/routing-flow-visual.html?scenario=healthy')
    await expect(page.getByTestId('runtime-flow-card-route')).toHaveCount(3)
    await expect(page.getByTestId('runtime-data-flow-inspector')).toBeVisible()
    const scroll = page.getByRole('region', { name: 'Scrollable data flow graph' })
    await expect(scroll).toBeVisible()
    const initial = await page.evaluate(() => ({
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      scrollWidth: document.querySelector('.control-runtime-flow-scroll')?.scrollWidth ?? 0,
      clientWidth: document.querySelector('.control-runtime-flow-scroll')?.clientWidth ?? 0,
    }))
    expect(initial.pageOverflow).toBe(false)
    if (width <= 1024) {
      expect(initial.scrollWidth).toBeGreaterThan(initial.clientWidth)
      await scroll.focus()
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
    }
    await page.getByRole('button', { name: 'Show accessible path list' }).click()
    const list = page.getByRole('list', { name: 'Data paths with runtime evidence' })
    await expect(list.getByRole('link')).toHaveCount(3)
  })
}

test('later Route page displays truthful zero traffic without motion', async ({ page }) => {
  await page.goto('/e2e/fixtures/routing-flow-visual.html?scenario=healthy')
  await expect(page.getByTestId('runtime-flow-card-route')).toHaveCount(3)
  await page.getByRole('button', { name: 'Next Routes' }).click()
  const route = page.getByTestId('runtime-flow-card-route')
  await expect(route).toHaveCount(1)
  await expect(route).toContainText('Route #15')
  await expect(route).toContainText('0 evt/s')
  await expect(page.locator('.control-runtime-flow-particles')).toHaveCount(0)
  await expect(page.getByTestId('runtime-data-flow-page-range')).toContainText('Routes 4–4 of 4')
})


/**
 * Deterministic browser screenshot reference: actual React/SVG markup, not
 * AI-generated concept art. Reduced motion freezes animated delivery visuals;
 * separate live-motion tests continue to verify honest positive-rate activity.
 */
for (const [width, height] of [[1920, 1080], [1440, 900]] as const) {
  test('static visual baseline ' + width + 'x' + height, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.clock.setFixedTime(new Date('2026-10-24T12:30:00.000Z'))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/e2e/fixtures/routing-flow-visual.html?scenario=healthy')
    await expect(page.getByTestId('runtime-flow-card-route')).toHaveCount(3)
    await expect(page.getByTestId('runtime-data-flow-inspector')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await expect(page.getByTestId('dashboard-live-data-flows')).toHaveScreenshot(
      'dashboard-routing-flow-' + width + '.png',
      { animations: 'disabled', maxDiffPixelRatio: 0.01 },
    )
  })
}
