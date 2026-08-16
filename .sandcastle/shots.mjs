import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'

// Скриншоты для README и для дизайн-ревью. Оба набора снимаются с запущенного
// приложения (npm run dev), чтобы в README не попало то, чего в коде нет.
const DOCS = 'docs/screenshots'
const REVIEW = '.impeccable/review'
await mkdir(DOCS, { recursive: true })
await mkdir(REVIEW, { recursive: true })

const browser = await chromium.launch()

// Новость, у которой Rewrite уже лежит в базе: у бесплатного ключа модели
// жёсткий лимит запросов, и снимать надо готовый результат, а не таймаут.
const PIECE = 'https://tass.ru/obschestvo/28016695'
const MOOD = 'Драматично'

// Ждём, пока Rewrite подгрузится и осядет анимация «свежего оттиска»:
// элемент, пойманный на середине анимации, читается как отсутствующий.
async function openPiece(page) {
  // networkidle тут недостижим: при открытии страница просит neutral-Rewrite,
  // которого в базе нет, и модель отвечает не сразу.
  await page.goto(`http://localhost:5173/?n=${encodeURIComponent(PIECE)}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.getByRole('button', { name: MOOD }).click()
  await page.waitForSelector('.factcheck', { timeout: 60_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== 'running'),
  )
}

async function shoot(name, width, height, dir) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
  })
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
  await page.waitForSelector('.lead')
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
  console.log(`${dir}/${name}.png`)
  await page.close()
}

// 1. Ревью: выпуск целиком на десктопе и на телефоне.
await shoot('desktop', 1440, 900, REVIEW)
await shoot('mobile', 390, 844, REVIEW)

// 2. README: выпуск, страница новости, Fact Check крупно.
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
})
await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await page.waitForSelector('.lead')
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: `${DOCS}/issue.png` })
console.log(`${DOCS}/issue.png`)

await openPiece(page)
await page.screenshot({ path: `${DOCS}/piece.png`, fullPage: true })
console.log(`${DOCS}/piece.png`)
await page.screenshot({ path: `${REVIEW}/desktop-piece.png`, fullPage: true })
console.log(`${REVIEW}/desktop-piece.png`)

await page.locator('.factcheck').screenshot({ path: `${DOCS}/fact-check.png` })
console.log(`${DOCS}/fact-check.png`)

// 3. Ревью: страница новости на телефоне — самая плотная раскладка проекта.
const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
})
await phone.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await phone.waitForSelector('.lead')
await phone.evaluate(() => document.fonts.ready)
await openPiece(phone)
await phone.screenshot({ path: `${REVIEW}/mobile-piece.png`, fullPage: true })
console.log(`${REVIEW}/mobile-piece.png`)

// 4. Ревью: как выглядит потерянный Anchor. Настоящий компонент и настоящий
// CSS, подменён только ответ API: Rewrite с потерями в кэше сейчас нет, а
// проверить надо и знак, и то, что счёт сходится с рядом знаков.
const lost = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
})
await lost.route('**/api/articles/https*', async (route) => {
  const article = {
    link: PIECE,
    source: 'ТАСС',
    title: 'В ГД рассказали, какие модели ИИ смогут использовать чиновники',
    announce:
      'Госслужащие будут использовать только проверенные модели искусственного интеллекта, заявил зампред комитета Госдумы по информполитике Андрей Свинцов',
    publishedAt: '2026-08-16T09:47:46.000Z',
  }
  const anchors = ['ГД', 'ИИ', 'Госслужащие', 'Госдумы', 'Андрей', 'Свинцов'].map(
    (text) => ({ kind: 'name', text }),
  )
  await route.fulfill({
    json: {
      article,
      rewrite: {
        mood: 'dramatic',
        title: 'Госдума решила судьбу нейросетей в кабинетах',
        body: 'Чиновникам оставили только проверенные модели ИИ — так распорядились в Госдуме. Госслужащие узнали об этом от зампреда профильного комитета.',
        anchors,
        anchorCount: anchors.length,
        missing: [anchors[4], anchors[5]],
        attempts: 3,
        stub: false,
      },
    },
  })
})
await lost.goto(`http://localhost:5173/?n=${encodeURIComponent(PIECE)}`, {
  waitUntil: 'domcontentloaded',
})
await lost.waitForSelector('.factcheck')
await lost.evaluate(() => document.fonts.ready)
await lost.waitForFunction(() =>
  document.getAnimations().every((a) => a.playState !== 'running'),
)
await lost.screenshot({ path: `${REVIEW}/lost-anchor.png`, fullPage: true })
console.log(`${REVIEW}/lost-anchor.png`)

// 5. Ревью: состояние отказа. Модель может быть недоступна или упереться в
// лимит — читатель должен видеть не только проблему, но и выход из неё.
const failed = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
})
await failed.route('**/api/articles/https*', async (route) => {
  await route.fulfill({
    status: 502,
    json: { error: 'модель ответила 429' },
  })
})
await failed.goto(`http://localhost:5173/?n=${encodeURIComponent(PIECE)}`, {
  waitUntil: 'domcontentloaded',
})
await failed.waitForSelector('.retry')
await failed.evaluate(() => document.fonts.ready)
await failed.screenshot({ path: `${REVIEW}/error-state.png`, fullPage: true })
console.log(`${REVIEW}/error-state.png`)

await browser.close()
