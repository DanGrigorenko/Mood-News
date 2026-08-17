import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Rewrite } from '../../shared/api.mts'
import {
  openDb,
  listArticles,
  countArticles,
  getArticle,
  insertArticles,
  getRewrite,
  insertRewrite,
} from '../src/db.ts'
import { ingest, stripAgencyHeader, MIN_SNIPPET_LENGTH, type Feed } from '../src/ingest.ts'

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

// Полноценная страница Коммерсанта: текст длиннее порога MIN_SNIPPET_LENGTH,
// лежит в doc__text. Три абзаца, чтобы уверенно перевалить за 500 символов —
// короткая заметка в базу больше не попадает (issue #13).
const fullPage = (n: number) => `<html><body>
  <nav>Меню</nav>
  <p class="doc__text">Полный текст статьи ${n}: подробное изложение события с деталями,
    именами и числами, которого хватает, чтобы переписать под настроение и сверить факты,
    а не сочинять недостающее из голого заголовка. Абзац первый рассказывает обстоятельства
    и называет действующих лиц, не сваливая факты в перечень.</p>
  <p class="doc__text">Второй абзац статьи ${n} продолжает изложение, уточняет обстоятельства
    произошедшего и приводит слова участников, чтобы у пяти регистров было пространство
    разойтись, а не тесниться в одном предложении.</p>
  <p class="doc__text">Третий абзац статьи ${n} подводит промежуточный итог и описывает, что
    будет дальше и какие последствия ожидаются в ближайшее время.</p>
</body></html>`

const komFeed: Feed[] = [{ url: 'https://k.test/rss', source: 'Коммерсантъ' }]

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

// --- Срез служебной шапки агентства (issue #13) ---

test('дательная шапка РИА срезается из начала текста', () => {
  const sliced = stripAgencyHeader(
    'МОСКВА, 16 авг - РИА Новости. Бразильскому защитнику ЦСКА Мойзесу потребуется восстановление.',
  )
  assert.equal(sliced, 'Бразильскому защитнику ЦСКА Мойзесу потребуется восстановление.')
})

test('текст без шапки не меняется ни на символ', () => {
  const text = 'Обычная новость без шапки: событие произошло сегодня в центре Москвы.'
  assert.equal(stripAgencyHeader(text), text)
})

test('строка, похожая на шапку, но в середине текста, не трогается', () => {
  const text = 'Компания сообщила: МОСКВА, 16 авг - РИА Новости. это не начало, а середина.'
  assert.equal(stripAgencyHeader(text), text)
})

// --- Счётчик отброшенного считает все три причины (issue #30) ---

// Погасшая лента должна быть видна: одна публикация отсеивается по каждой из
// трёх причин отброса, и счётчик skipped считает их все за один прогон. Причины:
// нет тела на странице (заглушка вместо контейнера), текст короче порога, запрос
// страницы упал. Добавленной остаётся ровно одна полноценная новость.
test('skipped считает все три причины отброса за один прогон', async () => {
  const db = openDb(':memory:')
  const fourItems = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item><title>Полная</title><link>https://k.test/full</link>
        <description>a</description><pubDate>Mon, 16 Aug 2026 09:00:00 +0300</pubDate></item>
      <item><title>Без тела</title><link>https://k.test/nobody</link>
        <description>a</description><pubDate>Mon, 16 Aug 2026 09:00:00 +0300</pubDate></item>
      <item><title>Короткая</title><link>https://k.test/short</link>
        <description>a</description><pubDate>Mon, 16 Aug 2026 09:00:00 +0300</pubDate></item>
      <item><title>Упавшая</title><link>https://k.test/boom</link>
        <description>a</description><pubDate>Mon, 16 Aug 2026 09:00:00 +0300</pubDate></item>
    </channel></rss>`
  const result = await ingest(db, {
    feeds: komFeed,
    fetchFeed: async () => fourItems,
    fetchPage: async (url) => {
      if (url.endsWith('/full')) return fullPage(1)
      if (url.endsWith('/nobody')) return '<html><body>Servicepipe captcha</body></html>'
      if (url.endsWith('/short')) return `<html><body><p class="doc__text">Коротко.</p></body></html>`
      throw new Error('страница недоступна') // /boom
    },
  })

  assert.equal(result.added, 1)
  assert.equal(result.skipped, 3) // нет тела + короткий текст + упавший запрос
  assert.equal(countArticles(db), 1)
})

// --- Порог длины Snippet при Ingest (issue #13) ---

// Страница РИА: текст лежит в div.article__text. Длину текста задаём явно, чтобы
// проверять порог MIN_SNIPPET_LENGTH точно.
const riaFeed: Feed[] = [{ url: 'https://ria.test/rss', source: 'РИА Новости' }]
const riaFeedXml = `<?xml version="1.0"?>
  <rss version="2.0"><channel>
    <item><title>Заметка</title><link>https://ria.test/1</link>
      <description>анонс</description>
      <pubDate>Mon, 16 Aug 2026 09:00:00 +0300</pubDate></item>
  </channel></rss>`
const riaPage = (body: string) =>
  `<html><body><div class="article__text">${body}</div></body></html>`

async function ingestRia(body: string) {
  const db = openDb(':memory:')
  const result = await ingest(db, {
    feeds: riaFeed,
    fetchFeed: async () => riaFeedXml,
    fetchPage: async () => riaPage(body),
  })
  return { db, result }
}

test('Article короче порога длины в базу не попадает и считается skipped', async () => {
  const { db, result } = await ingestRia('я'.repeat(MIN_SNIPPET_LENGTH - 1))
  assert.equal(result.added, 0)
  assert.equal(result.skipped, 1)
  assert.equal(countArticles(db), 0)
})

test('Article ровно на пороге длины попадает в базу', async () => {
  const { db, result } = await ingestRia('я'.repeat(MIN_SNIPPET_LENGTH))
  assert.equal(result.added, 1)
  assert.equal(result.skipped, 0)
  assert.equal(countArticles(db), 1)
})

test('длина считается после среза шапки, а не до', async () => {
  // Сырой текст длиннее порога, но почти весь — шапка: после среза остаётся
  // короткий хвост, и Article отсеивается. Мерь мы до среза — она бы прошла.
  const header = 'МОСКВА, 16 авг - РИА Новости. '
  const tail = 'я'.repeat(MIN_SNIPPET_LENGTH - 20) // хвост короче порога
  assert.ok(header.length + tail.length >= MIN_SNIPPET_LENGTH) // до среза — прошла бы
  const { db, result } = await ingestRia(header + tail)
  assert.equal(result.added, 0) // после среза хвост короче порога
  assert.equal(result.skipped, 1)
  assert.equal(countArticles(db), 0)
})

test('уже сохранённая Article с пустым анонсом не отдаётся в выдаче', () => {
  const db = openDb(':memory:')
  insertArticles(db, [
    {
      link: 'https://src.test/empty',
      source: 'Коммерсантъ',
      title: 'Только заголовок',
      announce: '',
      publishedAt: '2026-08-16T09:00:00.000Z',
    },
    {
      link: 'https://src.test/full',
      source: 'Коммерсантъ',
      title: 'С анонсом',
      announce: 'Есть текст',
      publishedAt: '2026-08-16T10:00:00.000Z',
    },
  ])

  assert.equal(listArticles(db).length, 1)
  assert.equal(listArticles(db)[0].link, 'https://src.test/full')
  assert.equal(getArticle(db, 'https://src.test/empty'), undefined)
})

// Форма таблицы rewrites сменилась (issue #23), миграций в проекте нет. База,
// созданная прежней формой, должна открыться и работать, а не ронять чтение
// кэша на каждой новости.
test('база прежней формы rewrites открывается и снова кэширует Rewrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moodnews-'))
  const path = join(dir, 'old.db')
  const old = new DatabaseSync(path)
  old.exec(`CREATE TABLE rewrites (
    link TEXT NOT NULL, mood TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (link, mood))`)
  old.prepare('INSERT INTO rewrites VALUES (?, ?, ?, ?)').run(
    'https://k.test/1', 'joyful', 'старый заголовок', 'старое тело')
  old.close()

  const db = openDb(path)
  try {
    assert.equal(getRewrite(db, 'https://k.test/1', 'joyful'), undefined)

    const rewrite: Rewrite = {
      mood: 'joyful', title: 'Новый', body: 'Текст', anchors: [], anchorCount: 0,
      missing: [], attempts: 1, stub: false, unchanged: false,
      meaningCheck: 'passed', distortion: '',
    }
    insertRewrite(db, 'https://k.test/1', 'joyful', rewrite)
    assert.deepEqual(getRewrite(db, 'https://k.test/1', 'joyful'), rewrite)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
