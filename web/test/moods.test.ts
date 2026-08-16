import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moodsSchema } from '../src/moods.ts'

test('moodsSchema принимает список Mood с id и label', () => {
  const parsed = moodsSchema.parse({
    moods: [
      { id: 'neutral', label: 'Нейтрально' },
      { id: 'joyful', label: 'Радостно' },
    ],
  })
  assert.equal(parsed.moods.length, 2)
  assert.equal(parsed.moods[0].id, 'neutral')
})

test('moodsSchema отвергает Mood без label', () => {
  assert.throws(() => moodsSchema.parse({ moods: [{ id: 'neutral' }] }))
})
