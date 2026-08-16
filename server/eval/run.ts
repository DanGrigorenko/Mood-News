import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { MOOD_LABELS, type Mood } from '../src/mood.ts'
import { generateRewrite, type Rewrite } from '../src/rewrite.ts'
import { callModelOverHttp, callMeaningCheckOverHttp, hasApiKey } from '../src/llm.ts'
import type { Article } from '../src/rss.ts'
import { summarize, formatSummary } from './aggregate.ts'

// Раннер eval (issue #12): гоняет замороженный корпус из 10 Snippet во всех пяти
// Mood через generateRewrite с НАСТОЯЩИМИ HTTP-вызовами модели и судьи, печатает
// все 50 Rewrite целиком и сводку против планки. Отдельная команда `npm run
// eval`: она стоит денег и недетерминирована, поэтому в `npm test` не входит и в
// CI не висит. Корпус заморожен, чтобы сравнивать «до» и «после» правки промпта
// на одном материале.

const MOODS: Mood[] = ['neutral', 'joyful', 'sad', 'ironic', 'dramatic']

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
  console.log(`Eval: ${corpus.length} Snippet × ${MOODS.length} Mood — живые вызовы модели.\n`)

  const rewrites: Rewrite[] = []
  for (const entry of corpus) {
    const article = articleOf(entry)
    for (const mood of MOODS) {
      const rewrite = await generateRewrite(
        article,
        mood,
        callModelOverHttp,
        callMeaningCheckOverHttp,
      )
      rewrites.push(rewrite)
      printRewrite(entry, rewrite)
    }
  }

  console.log('\n' + '='.repeat(72))
  console.log(formatSummary(summarize(rewrites)))
}

await main()
