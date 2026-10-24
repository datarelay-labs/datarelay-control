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
    await expect(page.getByTestId('runtime-flow-card-route')).toHaveCount(4)
    await expect(page.getByTestId('runtime-flow-card-destination')).toHaveCount(4)
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
  await expect(page.getByTestId('runtime-flow-card-route')).toHaveCount(4)
  await expect(page.getByTestId('runtime-data-flow-evidence')).toContainText('stale')
  await expect(page.locator('.control-runtime-flow-glow')).toHaveCount(0)
  await expect(page.locator('.control-runtime-flow-particles')).toHaveCount(0)
  await expect(page.getByText(/receiver status not implied/)).toBeVisible()
})
