import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, listArticles, countArticles, getArticle, insertArticles } from '../src/db.ts'
import { ingest } from '../src/ingest.ts'

// Лента отдаёт только Snippet (заголовок + анонс); полный текст Ingest забирает
// со страницы (issue #11). Источник в тестах — Коммерсантъ: его страница —
// абзацы <p class="doc__text">.
const feedXml = (n: number) => `<?xml version="1.0"?>
  <rss version="2.0"><channel>
    <item><title>Новость ${n}</title><link>https://k.test/${n}</link>
      <description>Короткий анонс ${n}</description>
      <pubDate>Mon, 16 Aug 2026 09:00:00 +0300</pubDate></item>
    <item><title>Новость ${n + 1}</title><link>https://k.test/${n + 1}</link>
      <description>Короткий анонс ${n + 1}</description>
      <pubDate>Mon, 16 Aug 2026 10:00:00 +0300</pubDate></item>
  </channel></rss>`

// Полноценная страница Коммерсанта: текст длиннее порога, лежит в doc__text.
const fullPage = (n: number) => `<html><body>
  <nav>Меню</nav>
  <p class="doc__text">Полный текст статьи ${n}: подробное изложение события с деталями,
    именами и числами, которого хватает, чтобы переписать под настроение и сверить факты,
    а не сочинять недостающее из голого заголовка. Абзац первый.</p>
  <p class="doc__text">Второй абзац статьи ${n} с продолжением и уточнениями обстоятельств.</p>
</body></html>`

const komFeed = [{ url: 'https://k.test/rss', source: 'Коммерсантъ' }]

test('ingest сохраняет полный текст со страницы как Snippet, не анонс', async () => {
  const db = openDb(':memory:')
  const result = await ingest(db, {
    feeds: komFeed,
    fetchFeed: async () => feedXml(1),
    fetchPage: async (url) => fullPage(Number(url.split('/').pop())),
  })

  assert.equal(result.added, 2)
  assert.equal(countArticles(db), 2)
  const stored = getArticle(db, 'https://k.test/1')
  assert.ok(stored)
  assert.match(stored!.announce, /Полный текст статьи 1/)
  assert.doesNotMatch(stored!.announce, /Короткий анонс/)
})

test('повторный Ingest уже известной публикации ничего не добавляет', async () => {
  const db = openDb(':memory:')
  const opts = {
    feeds: komFeed,
    fetchFeed: async () => feedXml(1),
    fetchPage: async (url: string) => fullPage(Number(url.split('/').pop())),
  }

  const first = await ingest(db, opts)
  const second = await ingest(db, opts)

  assert.equal(first.added, 2)
  assert.equal(second.added, 0)
  assert.equal(countArticles(db), 2)
})

// Новость, чей полный текст достать не удалось (страница-заглушка, нет нужного
// контейнера), в базу не попадает — огрызков быть не должно (issue #11).
test('новость без доступного полного текста пропускается и считается', async () => {
  const db = openDb(':memory:')
  const result = await ingest(db, {
    feeds: komFeed,
    fetchFeed: async () => feedXml(1),
    fetchPage: async (url) =>
      url.endsWith('/1') ? fullPage(1) : '<html><body>Servicepipe captcha</body></html>',
  })

  assert.equal(result.added, 1)
  assert.equal(result.skipped, 1)
  assert.equal(countArticles(db), 1)
  assert.ok(getArticle(db, 'https://k.test/1'))
  assert.equal(getArticle(db, 'https://k.test/2'), undefined)
})

// Сбой на одной новости (страница не открылась) не роняет Ingest — остальные
// сохраняются (issue #11).
test('сбой запроса одной страницы не роняет Ingest', async () => {
  const db = openDb(':memory:')
  const result = await ingest(db, {
    feeds: komFeed,
    fetchFeed: async () => feedXml(1),
    fetchPage: async (url) => {
      if (url.endsWith('/2')) throw new Error('страница недоступна')
      return fullPage(1)
    },
  })

  assert.equal(result.added, 1)
  assert.equal(result.skipped, 1)
  assert.equal(countArticles(db), 1)
})

test('недоступность одной ленты не роняет Ingest — остальные сохраняются', async () => {
  const db = openDb(':memory:')
  const result = await ingest(db, {
    feeds: [
      { url: 'https://down.test/rss', source: 'Коммерсантъ' },
      { url: 'https://ok.test/rss', source: 'Коммерсантъ' },
    ],
    fetchFeed: async (url: string) => {
      if (url.includes('down')) throw new Error('лента недоступна')
      return feedXml(10)
    },
    fetchPage: async (url: string) => fullPage(Number(url.split('/').pop())),
  })
  assert.equal(result.added, 2)
  assert.equal(countArticles(db), 2)
})

// Стартовый Ingest не должен молчать до конца: ход работы сообщается по мере
// обработки лент (issue #11).
test('ingest сообщает о ходе работы через onProgress', async () => {
  const db = openDb(':memory:')
  const messages: string[] = []
  await ingest(db, {
    feeds: komFeed,
    fetchFeed: async () => feedXml(1),
    fetchPage: async (url) => fullPage(Number(url.split('/').pop())),
    onProgress: (m) => messages.push(m),
  })

  assert.ok(messages.length > 0, 'onProgress должен быть вызван хотя бы раз')
  assert.ok(messages.some((m) => m.includes('Коммерсантъ')))
})

test('уже сохранённая Article с пустым анонсом не отдаётся в выдаче', () => {
  const db = openDb(':memory:')
  insertArticles(db, [
    {
      link: 'https://src.test/empty',
      source: 'A',
      title: 'Только заголовок',
      announce: '',
      publishedAt: '2026-08-16T09:00:00.000Z',
    },
    {
      link: 'https://src.test/full',
      source: 'A',
      title: 'С анонсом',
      announce: 'Есть текст',
      publishedAt: '2026-08-16T10:00:00.000Z',
    },
  ])

  assert.equal(listArticles(db).length, 1)
  assert.equal(listArticles(db)[0].link, 'https://src.test/full')
  assert.equal(getArticle(db, 'https://src.test/empty'), undefined)
})
