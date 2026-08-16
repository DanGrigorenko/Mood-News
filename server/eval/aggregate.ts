import type { Rewrite } from '../src/rewrite.ts'

// Планка продакшн-готовности промпта (issue #12). Детерминированные проверки —
// только абсолют: 50/50 по Missing Anchor и 50/50 по unchanged. От
// недетерминированного судьи Meaning Check требовать 100% — гоняться за
// собственным шумом, поэтому порог 48/50 (допускается до двух срабатываний на
// шум). Корпус — 10 замороженных Snippet × 5 Mood.
export const EVAL_CORPUS_SIZE = 50
export const MEANING_CHECK_ALLOWANCE = 2

export type EvalSummary = {
  total: number
  // Сколько Rewrite прошли Fact Check (Missing Anchor пуст).
  anchorsKept: number
  // Сколько Rewrite отличаются от Snippet (не unchanged).
  changed: number
  // Сколько Rewrite прошли Meaning Check.
  meaningPassed: number
  // Взяты ли все три планки разом.
  productionReady: boolean
}

// Чистая функция «список Rewrite → сводка» (issue #12): вынесена из раннера,
// чтобы планка была проверяема без обращения к живой модели. Раннер сам ходит в
// сеть и тестами не покрывается — проверяется эта агрегация.
export function summarize(rewrites: Rewrite[]): EvalSummary {
  const total = rewrites.length
  const anchorsKept = rewrites.filter((r) => r.missing.length === 0).length
  const changed = rewrites.filter((r) => !r.unchanged).length
  const meaningPassed = rewrites.filter((r) => r.meaningCheck === 'passed').length

  const productionReady =
    total === EVAL_CORPUS_SIZE &&
    anchorsKept === total && // 50/50 — абсолют
    changed === total && // 50/50 — абсолют
    meaningPassed >= total - MEANING_CHECK_ALLOWANCE // ≥ 48/50

  return { total, anchorsKept, changed, meaningPassed, productionReady }
}

// Человекочитаемая сводка для вывода раннера.
export function formatSummary(s: EvalSummary): string {
  return [
    `Всего Rewrite: ${s.total}`,
    `Fact Check (Anchor целы): ${s.anchorsKept}/${s.total}  [планка ${s.total}/${s.total}]`,
    `Отличаются от Snippet: ${s.changed}/${s.total}  [планка ${s.total}/${s.total}]`,
    `Meaning Check пройден: ${s.meaningPassed}/${s.total}  [планка ${s.total - MEANING_CHECK_ALLOWANCE}/${s.total}]`,
    s.productionReady ? 'ИТОГ: планка взята ✅' : 'ИТОГ: планка НЕ взята ❌',
  ].join('\n')
}
