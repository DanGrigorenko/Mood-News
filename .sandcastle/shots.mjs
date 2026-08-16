import { chromium } from 'playwright'

const OUT = 'docs/screenshots'
const TITLE = 'Во Внуково' // карточка с закэшированным neutral-Rewrite

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })

await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await page.waitForSelector('.card')

// 1. Грид
await page.screenshot({ path: `${OUT}/grid.png` })
console.log('grid.png')

// 2. Открытая карточка side-by-side
const card = page.locator('.card', { hasText: TITLE }).first()
await card.scrollIntoViewIfNeeded()
await card.click()
await page.waitForSelector('.modal .side-by-side')
// дождаться, пока Rewrite подгрузится (пропадёт индикатор «Переписываю…»)
await page.waitForSelector('.modal .loading', { state: 'detached' })
await page.waitForSelector('.modal .factcheck')
await page.locator('.modal').screenshot({ path: `${OUT}/side-by-side.png` })
console.log('side-by-side.png')

// 3. Бейдж Fact Check крупным планом
await page.locator('.modal .factcheck').screenshot({ path: `${OUT}/fact-check.png` })
console.log('fact-check.png')

await browser.close()
