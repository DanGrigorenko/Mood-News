// Непохожесть — «копия или переписано» одним module (issue #28, PRD #26). На
// вопрос «насколько Rewrite далёк от Snippet» и «какие куски перенесены дословно»
// отвечает одно место: нормализация, вырезание прямой речи, словесные триграммы,
// доля уцелевших, порог и список уцелевших кусков. Раньше это было разрезано —
// формулы жили в module переписывания, а порог в module Verdict, откуда
// переписывание реэкспортировало его обратно. Чтобы откалибровать порог, теперь
// достаточно одного файла.

// Порог непохожести: Rewrite считается unchanged, если доля словесных триграмм
// Snippet, дословно уцелевших в нём, не ниже порога (issue #13). Копия даёт около
// единицы, честное переписывание — заметно меньше. Живёт здесь, рядом с тем, что
// его считает: граница «копия / переписано» — часть непохожести. Module Verdict
// берёт порог отсюда.
export const UNCHANGED_SIMILARITY_THRESHOLD = 0.5

// Нормализация для сравнения Rewrite со Snippet: всё, кроме букв и цифр,
// схлопывается в один пробел, регистр гасится. Так различие лишь в пробелах,
// регистре или пунктуации переписыванием не считается (issue #8).
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Прямая речь вырезается перед сравнением: цитата обязана пережить
// переписывание дословно (Anchor вида quote), и её уцелевшие триграммы говорят о
// послушании, а не о лени. На короткой новости, где цитата — треть текста, они
// одни давали sim 0.85 при честно переписанном остатке.
function withoutQuotes(text: string): string {
  return text.replace(/«[^»]*»/g, ' ')
}

// Словесные триграммы нормализованного текста: тройки соседних слов. Одиночные
// слова для меры непохожести не годятся — новость обязана переиспользовать
// существительные события, и по униграммам честный Rewrite неотличим от копии.
function wordTrigrams(text: string): string[] {
  const words = normalize(text).split(' ').filter(Boolean)
  const grams: string[] = []
  for (let i = 0; i + 3 <= words.length; i++) {
    grams.push(words.slice(i, i + 3).join(' '))
  }
  return grams
}

// Доля словесных триграмм Snippet, дословно уцелевших в Rewrite (0…1). Чистая
// функция: сравнение идёт по склейке заголовка и тела — так же, как Fact Check.
// Snippet короче трёх слов триграмм не даёт — тогда падаем на сравнение на
// тождество нормализованных строк (порог длины Ingest такого не пропустит, но
// функция обязана быть тотальной).
export function unchangedSimilarity(rewrite: string, snippet: string): number {
  const snippetGrams = wordTrigrams(withoutQuotes(snippet))
  if (snippetGrams.length === 0) {
    return normalize(rewrite) === normalize(snippet) ? 1 : 0
  }
  const rewriteGrams = new Set(wordTrigrams(withoutQuotes(rewrite)))
  const kept = snippetGrams.filter((g) => rewriteGrams.has(g)).length
  return kept / snippetGrams.length
}

// Сколько слов подряд должен насчитывать дословно перенесённый кусок, чтобы его
// стоило показывать модели. Шесть — длиннее случайного совпадения на обязательных
// существительных события и достаточно коротко, чтобы поймать перефраз по
// предложению, из которого состоят провалы на длинных статьях.
const SURVIVING_MIN_WORDS = 6
// Сколько кусков называть в ретрае. Список нужен, чтобы модель увидела, где
// именно она шла за источником, а не чтобы переписать за неё весь текст.
const SURVIVING_LIMIT = 3

// Куски Snippet, дословно уцелевшие в Rewrite, — от самого длинного. На длинной
// статье модель не тянет «пересобери заново» и идёт по источнику предложение за
// предложением, а голая просьба «смени формулировки» делает ретрай слепым.
// Названные куски делают его прицельным — так же, как Missing Anchor делает
// прицельным ретрай по фактам. Цитаты исключены: они обязаны уцелеть дословно.
export function survivingFragments(rewrite: string, snippet: string): string[] {
  const words = normalize(withoutQuotes(snippet)).split(' ').filter(Boolean)
  const haystack = ` ${normalize(withoutQuotes(rewrite))} `
  const found: string[] = []
  let i = 0
  while (i < words.length) {
    let len = 0
    while (
      i + len < words.length &&
      haystack.includes(` ${words.slice(i, i + len + 1).join(' ')} `)
    ) {
      len++
    }
    if (len >= SURVIVING_MIN_WORDS) {
      found.push(words.slice(i, i + len).join(' '))
      i += len
    } else {
      i++
    }
  }
  return found.sort((a, b) => b.length - a.length).slice(0, SURVIVING_LIMIT)
}
