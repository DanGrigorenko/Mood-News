import { DatabaseSync } from 'node:sqlite'
import { articleSchema, type Article } from './rss.ts'
import { rewriteSchema, type Rewrite } from './rewrite.ts'
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
  // генерация ленивая, живёт вечно (docs/adr/0001). Rewrite хранится одной
  // записью в data (JSON) и на чтении валидируется той же rewriteSchema, которой
  // он описан в остальном коде: битая или устаревшая запись обнаруживается на
  // чтении, а не проявляется на экране. Отдельными колонками остаётся только
  // ключ пары — то, по чему реально ищут (issue #23). Добавление поля в Rewrite —
  // правка одной схемы, а не согласованные правки в раскладке по колонкам.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rewrites (
      link TEXT NOT NULL,
      mood TEXT NOT NULL,
      data TEXT NOT NULL,
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

// Чтение Rewrite из кэша по паре (link, mood). Запись хранится одной JSON-строкой
// в data и на чтении валидируется общей rewriteSchema: устаревшая (не хватает
// полей после правки схемы) или битая (не-JSON) запись читается как промах кэша,
// а не доезжает до экрана. stub:false восстанавливать отдельно не нужно — в кэш
// пишется только настоящий Rewrite (см. resolveRewrite), значение лежит в data.
export function getRewrite(
  db: DatabaseSync,
  link: string,
  mood: Mood,
): Rewrite | undefined {
  const row = db
    .prepare(`SELECT data FROM rewrites WHERE link = ? AND mood = ?`)
    .get(link, mood) as { data: string } | undefined
  if (!row) return undefined
  let json: unknown
  try {
    json = JSON.parse(row.data)
  } catch {
    return undefined
  }
  const parsed = rewriteSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

// Запись Rewrite в кэш. INSERT OR IGNORE: пара (link, mood) пишется однажды и
// живёт вечно, повтор не перезаписывает (docs/adr/0001). Весь Rewrite ложится
// одной JSON-строкой в data.
export function insertRewrite(
  db: DatabaseSync,
  link: string,
  mood: Mood,
  rewrite: Rewrite,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO rewrites (link, mood, data) VALUES (?, ?, ?)`,
  ).run(link, mood, JSON.stringify(rewrite))
}
