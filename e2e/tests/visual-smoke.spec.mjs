import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const targets = [
  {
    name: 'home',
    path: '/home',
    ready: (page) => page.getByPlaceholder('アーティスト・楽曲・気分で探す'),
  },
  {
    name: 'profile',
    path: '/profile',
    ready: (page) => page.getByRole('heading', { name: '音楽人格・プロフィール' }),
  },
  {
    name: 'pricing',
    path: '/pricing',
    ready: (page) => page.getByRole('heading', { name: '料金プラン' }),
  },
  {
    name: 'privacy-requests',
    path: '/privacy-requests',
    ready: (page) => page.getByRole('heading', { name: '個人データに関する請求' }),
  },
  {
    name: 'messages',
    path: '/messages',
    ready: (page) => page.getByRole('heading', { name: 'メッセージ' }),
  },
  {
    name: 'upload',
    path: '/upload',
    ready: (page) => page.getByRole('heading', { name: '楽曲をアップロード' }),
  },
]

test.describe('mobile visual smoke', () => {
  for (const target of targets) {
    test(`${target.name} has no horizontal overflow and emits a reference screenshot`, async ({ page }) => {
      await page.goto(target.path)
      await expect(target.ready(page)).toBeVisible()

      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))

      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)

      await mkdir('visual-artifacts', { recursive: true })
      await page.screenshot({
        path: `visual-artifacts/${target.name}-mobile.png`,
        fullPage: true,
        animations: 'disabled',
      })
    })
  }
})
