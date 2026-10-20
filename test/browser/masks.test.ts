import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { type Browser, chromium, type Locator, type Page } from '@playwright/test'
import { maskedScreenshot } from '../../src/journeys/browser.ts'
import { keyMasks } from '../../src/journeys/console.ts'

/**
 * The masks a failed J2 step paints over its screenshot, on a stand-in of the
 * Console's port page (`components/ports/details/ServiceInformation.tsx` and
 * fabric's `blockfrostport.hbs` rows) whose heading, label or key shape has
 * drifted. Each case takes the screenshot as a failed step does and reads its
 * pixels back: every pixel of the key's text must be the mask's colour.
 */

const key = 'blockfrost1qpzry9x8gf2tvdw0s3jn5'

/** The labels of the rows that write the key, as the Console shows them and drifted. */
const labels = { shown: ['Auth Token', 'Authenticated Endpoint URL'], drifted: ['API key', 'Keyed endpoint'] }

/** The port page, as the Console lays it out, with `heading` over the key's section and `label`s beside the key's rows. */
const portPage = (heading: string, [label, url]: string[], secret: string) => `<!doctype html>
<style>body { font: 14px sans-serif; } .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.value { grid-column: span 3; display: flex; } .copy { margin-left: 12px; }</style>
<div>
  <div><h2>About</h2><div class="grid">
    <div class="label"><div>Name</div></div><div class="value"><div>blockfrost-preprod-x7k2</div></div>
    <div class="label"><div>Network</div></div><div class="value"><div>cardano-preprod</div></div>
  </div></div>
  <div><h2>${heading}</h2><div class="grid">
    <div class="label"><div>Endpoint URL</div></div><div class="value"><div>https://cardano-preprod.blockfrost-m1.demeter.run</div><div class="copy">⧉</div></div>
    <div class="label"><div>${url}</div></div><div class="value"><div>https://${secret}.cardano-preprod.blockfrost-m1.demeter.run</div><div class="copy">⧉</div></div>
    <div class="label"><div>${label}</div></div><div class="value"><div>${secret}</div><div class="copy">⧉</div></div>
  </div></div>
</div>`

describe('the key masks', () => {
  let browser: Browser
  let dir: string
  before(async () => {
    browser = await chromium.launch()
    dir = await mkdtemp(join(tmpdir(), 'e2e-masks-'))
  })
  after(async () => {
    await browser.close()
    await rm(dir, { recursive: true, force: true })
  })

  /** The boxes of the text runs on `page` that hold `secret`, in CSS pixels. */
  const secretBoxes = (page: Page, secret: string) =>
    page.evaluate((s) => {
      const boxes: { x: number; y: number; width: number; height: number }[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(s) ?? -1
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + s.length)
        for (const r of range.getClientRects()) boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height })
      }
      return boxes
    }, secret)

  /** How many pixels of `secret`'s text a masked screenshot of `page` leaves unpainted, and how many it checked. */
  async function unmasked(page: Page, secret: string, masks: Locator[], name: string): Promise<{ left: number; checked: number }> {
    const boxes = await secretBoxes(page, secret)
    assert.equal(boxes.length, 2, 'the key shows in two rows')
    const path = await maskedScreenshot(page, dir, name, masks)
    const png = (await readFile(path)).toString('base64')
    const reader = await browser.newPage()
    try {
      return await reader.evaluate(
        async ({ png, boxes }) => {
          const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob())
          const canvas = new OffscreenCanvas(image.width, image.height)
          const context = canvas.getContext('2d')!
          context.drawImage(image, 0, 0)
          let left = 0
          let checked = 0
          for (const b of boxes) {
            const [x, y] = [Math.ceil(b.x), Math.ceil(b.y)]
            const [w, h] = [Math.floor(b.x + b.width) - x, Math.floor(b.y + b.height) - y]
            const { data } = context.getImageData(x, y, w, h)
            for (let i = 0; i < data.length; i += 4) {
              checked += 1
              if (!(data[i]! > 245 && data[i + 1]! < 10 && data[i + 2]! > 245)) left += 1
            }
          }
          return { left, checked }
        },
        { png, boxes },
      )
    } finally {
      await reader.close()
    }
  }

  const drifted = 'KEY-7F3A9C21B04E55D6A8'
  // Each drift alone, each pair of them, and all three once the key is known.
  const cases: [string, string, string[], string, boolean][] = [
    ['as the Console renders it', 'Instance info', labels.shown, key, false],
    ['under a heading that drifted', 'Instance information', labels.shown, key, false],
    ['beside labels that drifted', 'Instance info', labels.drifted, key, false],
    ['of a shape that drifted', 'Instance info', labels.shown, drifted, false],
    ['under a heading and beside labels that both drifted', 'Connection', labels.drifted, key, false],
    ['of a shape and beside labels that both drifted', 'Instance info', labels.drifted, drifted, false],
    ['of a shape and under a heading that both drifted', 'Connection', labels.shown, drifted, false],
    ['under a heading, beside labels and of a shape that all drifted, once the key is known', 'Connection', labels.drifted, drifted, true],
  ]
  for (const [what, heading, label, secret, known] of cases) {
    it(`paint over a key ${what}`, async () => {
      const page = await browser.newPage()
      try {
        await page.setContent(portPage(heading, label, secret))
        const { left, checked } = await unmasked(page, secret, keyMasks(page, known ? secret : undefined), what.replaceAll(' ', '-'))
        assert.ok(checked > 100, `${checked} pixels checked`)
        assert.equal(left, 0, `${left} of ${checked} pixels of the key left unpainted`)
      } finally {
        await page.close()
      }
    })
  }

  it('leave the key showing with no mask, so the check can fail', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent(portPage('Connection', labels.drifted, key))
      const { left, checked } = await unmasked(page, key, [], 'no-mask')
      assert.ok(left > checked / 2, `${left} of ${checked} pixels unpainted`)
    } finally {
      await page.close()
    }
  })
})
