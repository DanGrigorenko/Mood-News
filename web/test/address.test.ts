import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newsHref, readNewsLink, interceptClick } from '../src/address.ts'

// Формат `?n=` описан один раз: ссылка на плашке и адресная строка строятся тем
// же module, поэтому не могут разойтись. Проверяем, что построенное читается
// обратно как та же ссылка Article (в т.ч. со спецсимволами).
test('newsHref и readNewsLink — обратная пара для формата ?n=', () => {
  const link = 'https://example.com/новость?id=1&x=2'
  assert.equal(newsHref(link), `?n=${encodeURIComponent(link)}`)
  assert.equal(readNewsLink(newsHref(link)), link)
})

test('readNewsLink возвращает null, когда адреса новости в строке запроса нет', () => {
  assert.equal(readNewsLink(''), null)
  assert.equal(readNewsLink('?other=1'), null)
})

// Обычный левый клик перехватываем (переход внутри страницы), клик с любым
// модификатором отдаём браузеру — открыть в новой вкладке, скопировать адрес.
// Предикат принимает набор модификаторов, а не событие React.
test('interceptClick: обычный левый клик перехватывается', () => {
  assert.equal(
    interceptClick({
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }),
    true,
  )
})

test('interceptClick: клик с каждым из четырёх модификаторов не перехватывается', () => {
  const base = {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  }
  for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
    assert.equal(interceptClick({ ...base, [mod]: true }), false, mod)
  }
})
