import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MOOD_IDS } from '../src/mood.ts'
import { generateRewrite, unchangedSimilarity } from '../src/rewrite.ts'
import { callModelOverHttp, callMeaningCheckOverHttp } from '../src/llm.ts'

// ponytail: одноразовый зонд — печатает similarity каждой попытки, чтобы понять,
// почему Rewrite похож на Snippet. Удалить после диагностики.
const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL('./corpus.json', import.meta.url)), 'utf8'),
) as Array<{ id: string; link: string; source: string; title: string; announce: string; publishedAt: string }>

const which = process.argv[2] ?? 'death'
const entry = corpus.find((e) => e.id === which) ?? corpus[0]!

console.log(`SNIPPET [${entry.id}] ${entry.title}\n${entry.announce}\n`)
// ponytail: провайдер отдаёт 429 после нескольких подряд — пауза и пара ретраев.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= 5 || !/429|timeout/.test(String(err))) throw err
      await sleep(20_000)
    }
  }
}

for (const mood of MOOD_IDS) {
  const r = await withRetry(() =>
    generateRewrite(entry, mood, callModelOverHttp, callMeaningCheckOverHttp),
  )
  await sleep(3_000)
  const sim = unchangedSimilarity(`${r.title}\n${r.body}`, `${entry.title}\n${entry.announce}`)
  console.log('─'.repeat(70))
  console.log(`${mood}  sim=${sim.toFixed(2)} attempts=${r.attempts} missing=${r.missing.map((a) => a.text).join(' | ')} meaning=${r.meaningCheck} ${r.distortion}`)
  console.log(r.title)
  console.log(r.body)
}
