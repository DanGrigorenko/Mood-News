import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moodsPayload } from '../src/mood.ts'
import { moodSchema, moodsResponseSchema } from '../../shared/api.mts'

test('moodsPayload удовлетворяет общей схеме ответа /api/moods', () => {
  // Тот же конверт, которым ответ разбирает фронт (shared/api.mts): расхождение
  // формы теперь падает здесь, а не пустым экраном.
  assert.doesNotThrow(() => moodsResponseSchema.parse(moodsPayload()))
})

test('GET /api/moods отдаёт все пять Mood с человеческими названиями', () => {
  const { moods } = moodsPayload()
  assert.equal(moods.length, 5)
  assert.deepEqual(
    moods.map((m) => m.id),
    ['neutral', 'joyful', 'sad', 'ironic', 'dramatic'],
  )
  for (const m of moods) {
    assert.ok(m.label.length > 0)
  }
})

test('известный Mood проходит схему, произвольный отклоняется', () => {
  assert.equal(moodSchema.safeParse('ironic').success, true)
  assert.equal(moodSchema.safeParse('восторженно').success, false)
  assert.equal(moodSchema.safeParse('').success, false)
})
