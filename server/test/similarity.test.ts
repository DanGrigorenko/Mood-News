import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  unchangedSimilarity,
  survivingFragments,
  UNCHANGED_SIMILARITY_THRESHOLD,
} from '../src/similarity.ts'

// --- Мера непохожести: доля уцелевших словесных триграмм (issue #13) ---

test('survivingFragments называет длинные дословно перенесённые куски', () => {
  const snippet =
    'Пожарным потребовалось около 6 часов, чтобы локализовать возгорание. Причиной стало короткое замыкание.'
  const rewrite =
    'Беда пришла вечером. Пожарным потребовалось около 6 часов чтобы локализовать возгорание, и это была долгая ночь.'
  const found = survivingFragments(rewrite, snippet)
  assert.equal(found.length, 1)
  assert.match(found[0]!, /пожарным потребовалось около 6 часов чтобы локализовать возгорание/)
})

test('survivingFragments молчит, когда текст переписан', () => {
  const snippet = 'Пожарным потребовалось около 6 часов, чтобы локализовать возгорание.'
  const rewrite = 'Огонь удалось сбить лишь к утру — борьба заняла 6 часов.'
  assert.deepEqual(survivingFragments(rewrite, snippet), [])
})

test('unchangedSimilarity: дословная цитата не идёт в счёт похожести', () => {
  // Цитата обязана уцелеть дословно, поэтому её триграммы о переписывании
  // ничего не говорят. Тот же текст без цитаты переписан целиком.
  const quote = '«инфляция остаётся выше цели, и мы готовы удерживать ставку столько, сколько потребуется»'
  const snippet = `На пресс-конференции по итогам заседания глава ЦБ заявила: ${quote}.`
  const rewrite = `Регулятор не намерен смягчать политику, и вот прямая речь: ${quote}.`
  assert.ok(unchangedSimilarity(rewrite, snippet) < UNCHANGED_SIMILARITY_THRESHOLD)
})

test('unchangedSimilarity: копия Snippet даёт максимум', () => {
  const snippet = 'Мэр Москвы сообщил о росте на 15 процентов в 2026 году подряд'
  assert.equal(unchangedSimilarity(snippet, snippet), 1)
})

test('unchangedSimilarity: перестановка слов и пара синонимов всё ещё выше порога', () => {
  const snippet = 'Мэр Москвы сообщил о росте на 15 процентов в 2026 году подряд'
  // Заменены два слова, порядок в основном сохранён — это ещё копия по сути.
  const near = 'Мэр Москвы заявил о росте на 15 процентов в 2026 году подряд'
  assert.ok(unchangedSimilarity(near, snippet) >= UNCHANGED_SIMILARITY_THRESHOLD)
})

test('unchangedSimilarity: настоящее переписывание — ниже порога', () => {
  const snippet = 'Мэр Москвы сообщил о росте на 15 процентов в 2026 году подряд'
  const real = 'За 2026 год столичный показатель прибавил 15 процентов — так отчитались власти'
  assert.ok(unchangedSimilarity(real, snippet) < UNCHANGED_SIMILARITY_THRESHOLD)
})

// Реальный случай со скриншота (issue #13): срез шапки «МОСКВА, 16 авг» → «16
// августа» — формально изменение, и сравнение на тождество его пропускало. Мера
// непохожести обязана считать это unchanged: почти весь текст уцелел дословно.
test('unchangedSimilarity: замена шапки на дату — по-прежнему unchanged', () => {
  const snippet =
    'МОСКВА, 16 авг - РИА Новости. Бразильскому защитнику ЦСКА Мойзесу потребуется восстановление'
  const copy =
    '16 августа. РИА Новости. Бразильскому защитнику ЦСКА Мойзесу потребуется восстановление'
  assert.notEqual(snippet, copy) // на тождество — разные строки
  assert.ok(unchangedSimilarity(copy, snippet) >= UNCHANGED_SIMILARITY_THRESHOLD)
})
