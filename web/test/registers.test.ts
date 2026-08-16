import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Регрессия issue #9: выбранная кнопка Mood (register) должна быть видна.
// Прежняя вёрстка красила активную кнопку в цвет фона (foreground == background),
// и выбор был неотличим — белым по белому. Проверяем инвариант прямо по CSS:
// у активного register цвет отличается и от неактивного, и от фона страницы.
const css = readFileSync(
  fileURLToPath(new URL('../src/index.css', import.meta.url)),
  'utf8',
)

// Кастомные свойства из :root — чтобы разворачивать var(--x) в конкретный цвет.
function rootVars(source: string): Map<string, string> {
  const vars = new Map<string, string>()
  const root = source.match(/:root\s*\{([^}]*)\}/)?.[1] ?? ''
  for (const [, name, value] of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars.set(name.trim(), value.trim())
  }
  return vars
}

// Тело правила по точному селектору (первое совпадение).
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

// Значение свойства в блоке.
function decl(body: string, prop: string): string | undefined {
  return body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1]?.trim()
}

// Разворачиваем var(--x) до конкретного значения из :root.
function resolve(value: string | undefined, vars: Map<string, string>): string | undefined {
  if (!value) return value
  const ref = value.match(/^var\(\s*(--[\w-]+)\s*\)$/)
  return ref ? resolve(vars.get(ref[1]), vars) : value.toLowerCase()
}

test('выбранный register окрашен, а не белым по белому', () => {
  const vars = rootVars(css)
  const base = resolve(decl(ruleBody(css, '.register'), 'color'), vars)
  const active = resolve(
    decl(ruleBody(css, ".register[aria-pressed='true']"), 'color'),
    vars,
  )
  const paper = resolve(vars.get('--paper'), vars)

  // Активное состояние вообще задаёт цвет.
  assert.ok(active, 'у активного register не задан color')
  // Выбор виден: цвет отличается от неактивного.
  assert.notEqual(active, base, 'активный register не отличается от неактивного')
  // И не сливается с фоном страницы (тот самый баг «белым по белому»).
  assert.notEqual(active, paper, 'активный register сливается с фоном')
  const backgroundLike = new Set(['canvas', 'transparent', '#fff', '#ffffff'])
  assert.ok(
    !backgroundLike.has(active),
    'активный register окрашен цветом фона',
  )
})
