import { DatabaseSync } from 'node:sqlite'
import { articleSchema, type Article } from './rss.ts'

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

export function listArticles(db: DatabaseSync): Article[] {
  const rows = db
    .prepare(
      `SELECT link, source, title, announce, published_at AS publishedAt
       FROM articles ORDER BY published_at DESC`,
    )
    .all()
  return rows.map((row) => articleSchema.parse(row))
}
