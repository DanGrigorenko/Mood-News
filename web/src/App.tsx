import { useEffect, useState } from 'react'
import {
  fetchArticles,
  runIngest,
  formatAdded,
  formatPublished,
  type Article,
} from './articles.ts'
import { fetchMoods, type Mood } from './moods.ts'
import { fetchRewrite, factCheckSummary, type Rewrite } from './rewrite.ts'

// Кнопки переключателя Mood. Один и тот же список рисуется в шапке и в открытой
// карточке (issue #5), отличаются только обёртки — их оставляем на месте вызова.
function MoodButtons(props: {
  moods: Mood[]
  selected: string
  onSelect: (id: string) => void
}) {
  return props.moods.map((mood) => (
    <button
      key={mood.id}
      className={mood.id === props.selected ? 'mood active' : 'mood'}
      aria-pressed={mood.id === props.selected}
      onClick={() => props.onSelect(mood.id)}
    >
      {mood.label}
    </button>
  ))
}

export function App() {
  const [articles, setArticles] = useState<Article[]>([])
  const [moods, setMoods] = useState<Mood[]>([])
  const [selectedMood, setSelectedMood] = useState('neutral')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Открытая карточка и её Rewrite в выбранном Mood. Роутинга нет — одно
  // состояние в компоненте (issue #5).
  const [open, setOpen] = useState<Article | null>(null)
  const [rewrite, setRewrite] = useState<Rewrite | null>(null)
  const [rewriteLoading, setRewriteLoading] = useState(false)
  const [rewriteError, setRewriteError] = useState<string | null>(null)

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
    fetchMoods()
      .then(setMoods)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
  }, [])

  // Rewrite подгружается при открытии карточки и при смене Mood в открытой
  // карточке (issue #5): генерация ленивая, поэтому нужен индикатор загрузки.
  // cancelled гасит гонку, если Mood переключили быстрее, чем пришёл ответ.
  useEffect(() => {
    if (open === null) return
    let cancelled = false
    setRewriteLoading(true)
    setRewriteError(null)
    setRewrite(null)
    fetchRewrite(open.link, selectedMood)
      .then((r) => {
        if (!cancelled) setRewrite(r)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setRewriteError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setRewriteLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, selectedMood])

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

      <nav className="moods" aria-label="Настроение">
        <MoodButtons
          moods={moods}
          selected={selectedMood}
          onSelect={setSelectedMood}
        />
      </nav>

      {notice !== null && <p>{notice}</p>}
      {error !== null && <p className="error">ошибка: {error}</p>}

      <section className="grid">
        {articles.map((article) => (
          <article
            key={article.link}
            className="card"
            onClick={() => setOpen(article)}
          >
            <h2>{article.title}</h2>
            {article.announce !== '' && <p>{article.announce}</p>}
            <footer>
              <span>{article.source}</span>
              <time>{formatPublished(article.publishedAt)}</time>
            </footer>
          </article>
        ))}
      </section>

      {open !== null && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close"
              aria-label="Закрыть"
              onClick={() => setOpen(null)}
            >
              ✕
            </button>

            <div className="modal-moods">
              <MoodButtons
                moods={moods}
                selected={selectedMood}
                onSelect={setSelectedMood}
              />
            </div>

            <div className="side-by-side">
              <section className="pane">
                <h3>Оригинал</h3>
                <h2>{open.title}</h2>
                {open.announce !== '' && <p>{open.announce}</p>}
              </section>

              <section className="pane">
                <h3>Переписано</h3>
                {rewriteLoading && <p className="loading">Переписываю…</p>}
                {rewriteError !== null && (
                  <p className="error">ошибка: {rewriteError}</p>
                )}
                {rewrite !== null && !rewriteLoading && (
                  <>
                    <h2>{rewrite.title}</h2>
                    <p>{rewrite.body}</p>
                    {rewrite.stub && (
                      <p className="stub">
                        Модель недоступна — показан исходный текст.
                      </p>
                    )}
                    <div
                      className={
                        rewrite.missing.length === 0
                          ? 'factcheck ok'
                          : 'factcheck lost'
                      }
                    >
                      <strong>{factCheckSummary(rewrite)}</strong>
                      {rewrite.missing.length > 0 && (
                        <ul>
                          {rewrite.missing.map((anchor) => (
                            <li key={`${anchor.kind}:${anchor.text}`}>
                              {anchor.text}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </section>
            </div>

            <footer className="modal-footer">
              <a href={open.link} target="_blank" rel="noreferrer">
                Оригинальная публикация ↗
              </a>
              <span>
                {open.source} · {formatPublished(open.publishedAt)}
              </span>
            </footer>
          </div>
        </div>
      )}
    </main>
  )
}
