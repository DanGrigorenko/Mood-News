import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripMarkdown, parseModelContent, parseMeaningCheckContent } from '../src/parse.ts'

// Разбор ответа модели живёт отдельно от транспорта (issue #22): отладка «модель
// вернула мусор» начинается здесь, а не в коде про retry.

test('stripMarkdown снимает маркеры выделения и заголовки, текст без разметки не трогает', () => {
  assert.equal(stripMarkdown('# **Россия** победила'), 'Россия победила')
  assert.equal(stripMarkdown('Курс _вырос_ на `15%`'), 'Курс вырос на 15%')
  assert.equal(stripMarkdown('Обычный текст: 15%'), 'Обычный текст: 15%')
})

test('parseModelContent: валидный JSON → объект, мусор → null', () => {
  assert.deepEqual(parseModelContent('{"title":"a","body":"b"}'), {
    title: 'a',
    body: 'b',
  })
  assert.equal(parseModelContent('не json'), null)
  assert.equal(parseModelContent('{"title":"a"}'), null) // нет body
})

test('parseModelContent снимает markdown с title и body', () => {
  const out = parseModelContent(
    '{"title":"# **Россия** победила","body":"Курс _вырос_ на `15%`"}',
  )
  assert.deepEqual(out, { title: 'Россия победила', body: 'Курс вырос на 15%' })
})

test('parseModelContent не портит текст без markdown', () => {
  assert.deepEqual(parseModelContent('{"title":"Обычный текст","body":"Без разметки: 15%"}'), {
    title: 'Обычный текст',
    body: 'Без разметки: 15%',
  })
})

test('parseMeaningCheckContent: валидный вердикт → объект, мусор → null', () => {
  assert.deepEqual(parseMeaningCheckContent('{"consistent":true,"distortion":""}'), {
    consistent: true,
    distortion: '',
  })
  assert.equal(parseMeaningCheckContent('не json'), null)
  assert.equal(parseMeaningCheckContent('{"consistent":false}'), null) // нет distortion
})
