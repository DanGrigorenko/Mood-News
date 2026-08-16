import { useEffect, useState } from 'react'
import {
  fetchArticles,
  runIngest,
  formatAdded,
  formatPublished,
  type Article,
} from './articles.ts'

export function App() {
  const [articles, setArticles] = useState<Article[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  async function load() {
    try {
      setArticles(await fetchArticles())
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function refresh() {
    setRefreshing(true)
    setNotice(null)
    try {
      const added = await runIngest()
      setNotice(formatAdded(added))
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <main>
      <header>
        <h1>Mood News</h1>
        <button onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? 'Обновляю…' : 'Обновить'}
        </button>
      </header>
      {notice !== null && <p>{notice}</p>}
      {error !== null && <p>ошибка: {error}</p>}
      <section className="grid">
        {articles.map((article) => (
          <article key={article.link} className="card">
            <h2>
              <a href={article.link} target="_blank" rel="noreferrer">
                {article.title}
              </a>
            </h2>
            {article.announce !== '' && <p>{article.announce}</p>}
            <footer>
              <span>{article.source}</span>
              <time>{formatPublished(article.publishedAt)}</time>
            </footer>
          </article>
        ))}
      </section>
    </main>
  )
}
