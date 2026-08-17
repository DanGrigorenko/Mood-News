import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFeed } from '../src/rss.ts'

const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Пример ленты</title>
    <item>
      <title><![CDATA[Первая новость]]></title>
      <link>https://example.com/news/1</link>
      <description><![CDATA[<p>Анонс первой новости с числом 15%.</p>]]></description>
      <pubDate>Mon, 16 Aug 2026 09:00:00 +0300</pubDate>
    </item>
    <item>
      <title>Вторая новость</title>
      <link>https://example.com/news/2</link>
      <description>Просто текст анонса</description>
      <pubDate>Mon, 16 Aug 2026 10:30:00 +0300</pubDate>
    </item>
  </channel>
</rss>`

test('parseFeed достаёт Article со Snippet из RSS-ленты', () => {
  const articles = parseFeed(sampleFeed, 'Интерфакс')

  assert.equal(articles.length, 2)
  assert.deepEqual(articles[0], {
    link: 'https://example.com/news/1',
    source: 'Интерфакс',
    title: 'Первая новость',
    announce: 'Анонс первой новости с числом 15%.',
    publishedAt: '2026-08-16T06:00:00.000Z',
  })
})

test('parseFeed снимает HTML-теги, но сохраняет текст анонса как отдал Source', () => {
  const articles = parseFeed(sampleFeed, 'Интерфакс')
  assert.equal(articles[1].announce, 'Просто текст анонса')
  assert.equal(articles[1].title, 'Вторая новость')
})

test('parseFeed пропускает item без ссылки или заголовка, а не падает', () => {
  const broken = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item><title>Без ссылки</title></item>
      <item><link>https://example.com/ok</link><title>Целая</title></item>
    </channel></rss>`

  const articles = parseFeed(broken, 'Интерфакс')
  assert.equal(articles.length, 1)
  assert.equal(articles[0].link, 'https://example.com/ok')
})

test('parseFeed на мусоре вместо XML возвращает пустой список, а не бросает', () => {
  assert.deepEqual(parseFeed('это не xml', 'Интерфакс'), [])
  assert.deepEqual(parseFeed('', 'Интерфакс'), [])
})
