// Форма Article и конверты ответов описаны один раз в общем контракте
// (shared/api.mts) и импортируются сервером и фронтом напрямую. Здесь остаётся
// только настоящая логика фронта: запросы списка/Ingest и форматирование.
import {
  articlesResponseSchema,
  ingestResultSchema,
  type Article,
  type IngestResult,
} from '../../shared/api.mts'
import { apiFetch } from './api.ts'

export async function fetchArticles(): Promise<Article[]> {
  return (await apiFetch('/api/articles', articlesResponseSchema)).articles
}

// Ingest отдаёт и добавленное, и отброшенное: погасшая лента должна быть видна
// читателю (issue #30), поэтому наружу идёт весь результат, а не одно added.
export async function runIngest(): Promise<IngestResult> {
  return apiFetch('/api/ingest', ingestResultSchema, { method: 'POST' })
}

// Русская форма числительного «новость» для отчёта кнопки «Обновить».
function pluralNews(n: number): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return 'новостей'
  if (mod10 === 1) return 'новость'
  if (mod10 >= 2 && mod10 <= 4) return 'новости'
  return 'новостей'
}

// Отчёт кнопки «Обновить». Отброшенное (недоступный текст) показывается рядом с
// добавленным, чтобы погасшая лента была видна читателю (issue #30). Ничего не
// отброшено — про отброшенное молчим.
export function formatAdded(added: number, skipped = 0): string {
  const dropped = skipped > 0 ? `, отброшено ${skipped}` : ''
  if (added === 0) return `Новых новостей нет${dropped}`
  const verb = added % 10 === 1 && added % 100 !== 11 ? 'Добавлена' : 'Добавлено'
  return `${verb} ${added} ${pluralNews(added)}${dropped}`
}

// Короткая форма для строк выпуска: полная дата занимает две строки и рвёт
// ритм стана. На странице новости остаётся полная.
export function formatShort(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  return new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatPublished(iso: string): string {
  if (iso === '') return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  return new Date(ms).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
