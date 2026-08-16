import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { MOOD_LABELS, MOOD_IDS } from '../src/mood.ts'
import { generateRewrite, type Rewrite } from '../src/rewrite.ts'
import { unchangedSimilarity } from '../src/similarity.ts'
import { makeModelCall, makeMeaningCheckCall, httpTransport, hasApiKey, type Transport } from '../src/llm.ts'
import type { Article } from '../src/rss.ts'
import { summarize, formatSummary } from './aggregate.ts'

// Раннер eval (issue #12): гоняет замороженный корпус из 10 Snippet во всех пяти
// Mood через generateRewrite с НАСТОЯЩИМИ HTTP-вызовами модели и судьи, печатает
// все 50 Rewrite целиком и сводку против планки. Отдельная команда `npm run
// eval`: она стоит денег и недетерминирована, поэтому в `npm test` не входит и в
// CI не висит. Корпус заморожен, чтобы сравнивать «до» и «после» правки промпта
// на одном материале.

// Корпус — внешние данные для раннера, читаются с диска и валидируются zod.
const corpusEntrySchema = z.object({
  id: z.string(),
  category: z.string(),
  link: z.string(),
  source: z.string(),
  title: z.string(),
  announce: z.string(),
  publishedAt: z.string(),
})
type CorpusEntry = z.infer<typeof corpusEntrySchema>

function loadCorpus(): CorpusEntry[] {
  const path = fileURLToPath(new URL('./corpus.json', import.meta.url))
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return z.array(corpusEntrySchema).parse(raw)
}

function articleOf(entry: CorpusEntry): Article {
  return {
    link: entry.link,
    source: entry.source,
    title: entry.title,
    announce: entry.announce,
    publishedAt: entry.publishedAt,
  }
}

// Провайдер режет частые вызовы 429, а один прогон — это 50 Rewrite по 2+
// вызова: без пауз и ретраев раннер падает на середине и весь потраченный прогон
// уходит в никуда. Повтор по 429 и таймауту раннер больше не крутит сам —
// это делает Transport, тот же, что и в проде, но с длинными паузами: собственный
// цикл повтора и разбор текста ошибки регуляркой удалены, паузы больше не
// складываются (issue #29). Пауза между соседними Rewrite (вежливость к
// провайдеру, а не повтор) остаётся здесь — это решение раннера, а не политика
// транспорта.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RETRY_PAUSE_MS = 20_000
const BETWEEN_REWRITES_MS = 3_000
// Прежние MAX_RETRIES=5 попыток повтора — теперь пять длинных пауз транспорта.
const EVAL_RETRY_DELAYS_MS = Array<number>(5).fill(RETRY_PAUSE_MS)

// Транспорт eval: сеть и таймер берём прод-adapter, паузы повтора — длинные.
// Таймаут и обрыв сети приходят броском request; превращаем их в retryable 503,
// чтобы повтор по 429 И по таймауту шёл одним циклом транспорта, а не отдельной
// регуляркой по тексту ошибки в раннере (issue #29).
const evalTransport: Transport = {
  request: async (url, init) => {
    try {
      return await httpTransport.request(url, init)
    } catch {
      return new Response('', { status: 503 })
    }
  },
  sleep: httpTransport.sleep,
  retryDelays: EVAL_RETRY_DELAYS_MS,
}

const callModel = makeModelCall(evalTransport)
const callMeaningCheck = makeMeaningCheckCall(evalTransport)

function printRewrite(entry: CorpusEntry, rewrite: Rewrite): void {
  const kept = rewrite.anchorCount - rewrite.missing.length
  console.log('─'.repeat(72))
  console.log(`[${entry.id} · ${entry.category}] — ${MOOD_LABELS[rewrite.mood]}`)
  console.log(`  ${rewrite.title}`)
  console.log(`  ${rewrite.body}`)
  console.log(
    `  Fact Check: ${kept}/${rewrite.anchorCount}` +
      (rewrite.missing.length > 0
        ? ` · потеряно: ${rewrite.missing.map((a) => a.text).join(', ')}`
        : '') +
      // Голого unchanged мало: он говорит лишь «за порогом или нет». Само число
      // показывает, насколько Rewrite ушёл от Snippet, — по нему и калибруется
      // UNCHANGED_SIMILARITY_THRESHOLD.
      ` · sim: ${unchangedSimilarity(`${rewrite.title}\n${rewrite.body}`, `${entry.title}\n${entry.announce}`).toFixed(2)}` +
      ` · unchanged: ${rewrite.unchanged}` +
      ` · Meaning Check: ${rewrite.meaningCheck}` +
      (rewrite.distortion ? ` (${rewrite.distortion})` : '') +
      ` · попыток: ${rewrite.attempts}`,
  )
}

async function main(): Promise<void> {
  if (!hasApiKey()) {
    console.error(
      'LLM_API_KEY не задан. Eval ходит в живую модель — задайте ключ в .env и повторите.',
    )
    process.exitCode = 1
    return
  }

  const corpus = loadCorpus()
  console.log(`Eval: ${corpus.length} Snippet × ${MOOD_IDS.length} Mood — живые вызовы модели.\n`)

  const rewrites: Rewrite[] = []
  for (const entry of corpus) {
    const article = articleOf(entry)
    for (const mood of MOOD_IDS) {
      const rewrite = await generateRewrite(article, mood, callModel, callMeaningCheck)
      rewrites.push(rewrite)
      printRewrite(entry, rewrite)
      await sleep(BETWEEN_REWRITES_MS)
    }
  }

  console.log('\n' + '='.repeat(72))
  console.log(formatSummary(summarize(rewrites)))
}

await main()
