import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAdded, formatPublished, articlesSchema } from '../src/articles.ts'

test('formatAdded сообщает, сколько новостей добавил Ingest', () => {
  assert.equal(formatAdded(0), 'Новых новостей нет')
  assert.equal(formatAdded(1), 'Добавлена 1 новость')
  assert.equal(formatAdded(3), 'Добавлено 3 новости')
  assert.equal(formatAdded(11), 'Добавлено 11 новостей')
})

test('formatAdded показывает число отброшенных рядом с добавленными', () => {
  // Погасшая лента видна читателю: отброшенное соседствует с добавленным.
  assert.equal(formatAdded(2, 3), 'Добавлено 2 новости, отброшено 3')
  assert.equal(formatAdded(0, 5), 'Новых новостей нет, отброшено 5')
  // Ничего не отброшено — про отброшенное не говорим.
  assert.equal(formatAdded(1, 0), 'Добавлена 1 новость')
})

test('formatPublished переводит ISO-дату в читаемый вид, пустую — в прочерк', () => {
  assert.equal(formatPublished(''), '—')
  assert.match(formatPublished('2026-08-16T06:00:00.000Z'), /2026/)
})

test('articlesSchema отвергает ответ без обязательных полей Article', () => {
  assert.throws(() => articlesSchema.parse({ articles: [{ title: 'нет ссылки' }] }))
})
