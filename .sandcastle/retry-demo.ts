// Воспроизводимый прогон ретрая по Fact Check на реальной Article.
//
// Гоняется НАСТОЯЩИЙ цикл generateRewrite с настоящим извлечением Anchor и
// настоящим Fact Check (server/src/{rewrite,anchor}.ts). Чтобы ретрай сработал
// детерминированно (живая модель теряет Anchor редко и непредсказуемо), ответы
// модели здесь заскриптованы: в первой попытке она «забывает» число 56, Fact
// Check это ловит, во второй — по указанию из промпта возвращает его.
//
// Запуск: node .sandcastle/retry-demo.ts
import { extractAnchors, factCheck } from '../server/src/anchor.ts'
import { generateRewrite } from '../server/src/rewrite.ts'
import type { ChatMessage, ModelOutput } from '../server/src/llm.ts'
import type { Article } from '../server/src/rss.ts'

// Реальная новость из ленты Коммерсанта (Ingest 2026-08-16).
const article: Article = {
  link: 'https://www.kommersant.ru/doc/8890654',
  source: 'Коммерсантъ',
  title:
    'Пожар на складе Wildberries в Подольске тушат 56 пожарных // К тушению пожара на складе WB в Подольске привлекли 56 пожарных и 14 автоцистерн',
  announce:
    'К тушению возгорания на территории логистического комплекса Wildberries в подмосковном Подольске привлекли 56 пожарных и 14 автоцистерн. Об этом рассказал глава городского округа Григорий Артамонов в Telegram.',
  publishedAt: '2026-08-16T07:41:45.000Z',
}

const anchors = extractAnchors(`${article.title}\n${article.announce}`)

// Первая попытка теряет «56» («десятки пожарных»); вторая возвращает.
const DROPPED: ModelOutput = {
  title: 'Огненный ад под Подольском: склад Wildberries (WB) охвачен пламенем',
  body: 'Гигантский логистический комплекс Wildberries (WB) в подмосковном Подольске охвачен огнём. На укрощение стихии брошены десятки пожарных и 14 автоцистерн. О разгорающейся беде сообщил глава городского округа Григорий Артамонов в Telegram.',
}
const RESTORED: ModelOutput = {
  title:
    'Огненный ад под Подольском: 56 пожарных бьются со стихией на складе Wildberries (WB)',
  body: 'Гигантский логистический комплекс Wildberries (WB) в подмосковном Подольске охвачен огнём. На укрощение стихии брошены 56 пожарных и 14 автоцистерн. О разгорающейся беде сообщил глава городского округа Григорий Артамонов в Telegram.',
}

let attempt = 0
const scriptedModel = async (messages: ChatMessage[]): Promise<ModelOutput> => {
  attempt++
  const isRetry = messages.some((m) =>
    m.content.includes('потеряны обязательные фрагменты'),
  )
  const out = attempt === 1 ? DROPPED : RESTORED
  const fc = factCheck(`${out.title}\n${out.body}`, anchors)
  const verdict =
    fc.missing.length === 0
      ? 'все Anchor на месте → успех'
      : `потеряно ${fc.missing.map((a) => `«${a.text}»`).join(', ')} → ретрай`
  console.log(
    `попытка ${attempt}${isRetry ? ' (промпт требует вернуть потерянное)' : ''}:`,
  )
  console.log(`  заголовок: ${out.title}`)
  console.log(`  Fact Check: ${verdict}`)
  return out
}

console.log(`Article: ${article.link}`)
console.log(`Anchor (${anchors.length}): ${anchors.map((a) => `«${a.text}»`).join(', ')}\n`)

const rewrite = await generateRewrite(article, 'dramatic', scriptedModel)

console.log(
  `\nИтог: attempts=${rewrite.attempts}, anchorCount=${rewrite.anchorCount}, ` +
    `missing=${rewrite.missing.length === 0 ? '[]' : rewrite.missing.map((a) => `«${a.text}»`).join(', ')}`,
)
