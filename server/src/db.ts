import { DatabaseSync } from 'node:sqlite'
import { articleSchema, type Article } from './rss.ts'
import type { Rewrite } from './rewrite.ts'
import type { Anchor } from './anchor.ts'
import type { Mood } from './mood.ts'

// SQLite файлом, схема одним CREATE TABLE IF NOT EXISTS при старте — без ORM
// и без миграций (CODING_STANDARDS). Дедупликация Ingest держится на PRIMARY
// KEY по ссылке: одна публикация — одна строка.
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      link TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      announce TEXT NOT NULL,
      published_at TEXT NOT NULL
    )
  `)
  // Кэш и хранилище Rewrite — одно и то же: пара (link, mood) — первичный ключ,
  // генерация ленивая, живёт вечно (docs/adr/0001). anchors и missing — JSON.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rewrites (
      link TEXT NOT NULL,
      mood TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      anchors TEXT NOT NULL,
      missing TEXT NOT NULL,
      anchor_count INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      PRIMARY KEY (link, mood)
    )
  `)
  return db
}

// INSERT OR IGNORE + changes даёт число реально добавленных Article: повтор уже
// известной ссылки игнорируется молча и в счётчик не попадает.
export function insertArticles(db: DatabaseSync, articles: Article[]): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO articles (link, source, title, announce, published_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  let added = 0
  for (const a of articles) {
    const info = stmt.run(a.link, a.source, a.title, a.announce, a.publishedAt)
    added += Number(info.changes)
  }
  return added
}

export function countArticles(db: DatabaseSync): number {
  const row = db.prepare('SELECT count(*) AS c FROM articles').get() as { c: number }
  return row.c
}

// Article без анонса не отдаём: новые Ingest их и не сохраняют (issue #7), но
// в базе могли осесть записи, забранные до фильтра. Отсекаем их и на чтении,
// чтобы у каждой карточки был непустой текст под заголовком.
export function listArticles(db: DatabaseSync): Article[] {
  const rows = db
    .prepare(
      `SELECT link, source, title, announce, published_at AS publishedAt
       FROM articles WHERE trim(announce) <> '' ORDER BY published_at DESC`,
    )
    .all()
  return rows.map((row) => articleSchema.parse(row))
}

// Одна Article по её ссылке (первичному ключу) — undefined, если такой нет или
// у неё пустой анонс (см. listArticles).
export function getArticle(db: DatabaseSync, link: string): Article | undefined {
  const row = db
    .prepare(
      `SELECT link, source, title, announce, published_at AS publishedAt
       FROM articles WHERE link = ? AND trim(announce) <> ''`,
    )
    .get(link)
  return row ? articleSchema.parse(row) : undefined
}

// Форма строки таблицы rewrites: anchors и missing — JSON-строки, остальное как есть.
type RewriteRow = {
  mood: string
  title: string
  body: string
  anchors: string
  missing: string
  anchor_count: number
  attempts: number
}

// Чтение Rewrite из кэша. Данные наши же, записанные insertRewrite ниже, поэтому
// собираем объект напрямую; anchors и missing лежат JSON-строками.
export function getRewrite(
  db: DatabaseSync,
  link: string,
  mood: Mood,
): Rewrite | undefined {
  const row = db
    .prepare(
      `SELECT mood, title, body, anchors, missing, anchor_count, attempts
       FROM rewrites WHERE link = ? AND mood = ?`,
    )
    .get(link, mood) as RewriteRow | undefined
  if (!row) return undefined
  return {
    mood: row.mood as Mood,
    title: row.title,
    body: row.body,
    anchors: JSON.parse(row.anchors) as Anchor[],
    missing: JSON.parse(row.missing) as Anchor[],
    anchorCount: row.anchor_count,
    attempts: row.attempts,
    stub: false, // в кэш попадает только настоящий Rewrite (см. resolveRewrite)
  }
}

// Запись Rewrite в кэш. INSERT OR IGNORE: пара (link, mood) пишется однажды и
// живёт вечно, повтор не перезаписывает (docs/adr/0001).
export function insertRewrite(
  db: DatabaseSync,
  link: string,
  mood: Mood,
  rewrite: Rewrite,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO rewrites
       (link, mood, title, body, anchors, missing, anchor_count, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    link,
    mood,
    rewrite.title,
    rewrite.body,
    JSON.stringify(rewrite.anchors),
    JSON.stringify(rewrite.missing),
    rewrite.anchorCount,
    rewrite.attempts,
  )
}
