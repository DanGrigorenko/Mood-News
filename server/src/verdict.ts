import type { Anchor } from './anchor.ts'

// Verdict — один вердикт попытки переписывания на весь pipeline (issue #20,
// PRD #18). На вопрос «как прошла попытка» отвечают три потребителя:
// ранжирование попыток (betterVerdict), выход из ретрай-цикла (accepted) и
// решение о кэше (fitForCache). Раньше это были три независимых чтения полей
// Rewrite, и на meaningCheck:'skipped' они между собой не согласовывались только
// на глаз. Теперь определение одно; расхождение «выходим, но не кэшируем»
// выражено явно (accepted и fitForCache расходятся ровно на skipped).

// Исход Meaning Check — смысловой сверки Rewrite с источником (docs/adr/0005,
// docs/adr/0007): passed — исход события сохранён; failed — найдено искажение;
// skipped — сверка не отработала (нет ключа, сбой, не-JSON от судьи). skipped
// честно означает «не проверено», а не «пройдено».
export type MeaningCheck = 'passed' | 'failed' | 'skipped'

// Порог непохожести: Rewrite считается unchanged, если доля словесных триграмм
// Snippet, дословно уцелевших в нём, не ниже порога (issue #13). Копия даёт около
// единицы, честное переписывание — заметно меньше. Живёт здесь, потому что
// граница «копия / переписано» — часть вердикта; rewrite.ts его реэкспортирует.
export const UNCHANGED_SIMILARITY_THRESHOLD = 0.5

// Вход вердикта — то, что о попытке известно после сверок: список Missing Anchor,
// мера непохожести на Snippet (0…1), исход Meaning Check и найденный Distortion.
export type VerdictInput = {
  missing: Anchor[]
  similarity: number
  meaningCheck: MeaningCheck
  distortion: string
}

// Вердикт попытки. unchanged выведен из similarity по порогу; similarity остаётся
// для тай-брейка ранжирования (более далёкая от Snippet побеждает при равенстве).
export type Verdict = {
  missing: Anchor[]
  unchanged: boolean
  similarity: number
  meaningCheck: MeaningCheck
  distortion: string
}

// Каков вердикт по этой попытке. Единственное место, где similarity превращается
// в unchanged (порог включительно).
export function verdictOf(input: VerdictInput): Verdict {
  return {
    missing: input.missing,
    unchanged: input.similarity >= UNCHANGED_SIMILARITY_THRESHOLD,
    similarity: input.similarity,
    meaningCheck: input.meaningCheck,
    distortion: input.distortion,
  }
}

// Anchor-сверка пройдена: все Anchor на месте и текст непохож на Snippet. Гейт
// для Meaning Check (судью не тревожим на тексте, который и так провалил Anchor)
// и общая первая половина accepted и fitForCache.
export function anchorsPassed(v: Verdict): boolean {
  return v.missing.length === 0 && !v.unchanged
}

// Ранг вердикта: чем меньше, тем лучше. Порядок важности — по тому, что читатель
// получает на экране (комментарий сохранён дословно из прежнего rank, issue #13):
// копия Snippet хуже всего — это не Rewrite, а источник под вывеской
// «переписано»; дальше искажение исхода — оно неправда; потерянный Anchor мягче
// обоих — Fact Check показывает его честно, а текст остаётся настоящим
// переписыванием. skipped и passed по рангу неотличимы: ни один из них не failed.
function rank(v: Verdict): [number, number, number] {
  return [v.unchanged ? 1 : 0, v.meaningCheck === 'failed' ? 1 : 0, v.missing.length]
}

// Какой из двух вердиктов лучше: сначала по рангу, при равенстве — тот, что
// дальше от Snippet. При полном равенстве возвращается первый аргумент.
export function betterVerdict(a: Verdict, b: Verdict): Verdict {
  const [ra, rb] = [rank(a), rank(b)]
  for (let i = 0; i < ra.length; i++) {
    if (ra[i]! !== rb[i]!) return ra[i]! < rb[i]! ? a : b
  }
  return a.similarity <= b.similarity ? a : b
}

// Вердикт годен — ретраить не нужно, из цикла выходим. Anchor-сверка пройдена и
// Meaning Check не провален (passed или skipped). skipped выходит из цикла честно
// («не проверено»), но в кэш при этом не попадёт: см. fitForCache.
export function accepted(v: Verdict): boolean {
  return anchorsPassed(v) && v.meaningCheck !== 'failed'
}

// Годится ли вердикт для кэша (docs/adr/0008). Строже accepted ровно на один шаг:
// Meaning Check обязан быть именно passed. skipped (не проверено) и failed мимо
// кэша — иначе одна неудачная или непроверенная попытка стала бы вечным свойством
// новости (docs/adr/0001). Здесь и живёт расхождение «выходим, но не кэшируем».
export function fitForCache(v: Verdict): boolean {
  return anchorsPassed(v) && v.meaningCheck === 'passed'
}
