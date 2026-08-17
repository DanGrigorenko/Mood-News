// Адрес новости: `?n=<ссылка Article>`. Формат описан здесь один раз, чтобы
// ссылка на плашке выпуска (href) и адресная строка (pushState в route.ts) не
// разошлись. Чистый module — без React и без DOM: строит адрес, читает адрес из
// строки запроса и решает, перехватывать ли клик. Проверяется тестом (issue #31).

// Набор модификаторов клавиатуры при клике. Берём именно набор, а не событие
// React, чтобы предикат перехвата был четырьмя assert'ами, а не непроверяемой
// веткой внутри обработчика.
export type ClickModifiers = {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

// Адрес одной новости в строке запроса. :n — ссылка Article (первичный ключ),
// поэтому encodeURIComponent.
export function newsHref(link: string): string {
  return `?n=${encodeURIComponent(link)}`
}

// Ссылка открытой новости из строки запроса (`?n=...`), либо null — выпуск.
export function readNewsLink(search: string): string | null {
  return new URLSearchParams(search).get('n')
}

// Обычный левый клик перехватываем — переход внутри страницы, без перезагрузки.
// Клик с любым модификатором отдаём браузеру: так работают «открыть в новой
// вкладке», «скопировать адрес» и всё, чего ждут от настоящей ссылки.
export function interceptClick(mods: ClickModifiers): boolean {
  return !(mods.metaKey || mods.ctrlKey || mods.shiftKey || mods.altKey)
}
