import { useEffect, useState, type MouseEvent } from 'react'
import {
  fetchArticles,
  runIngest,
  formatAdded,
  formatPublished,
  formatShort,
  type Article,
} from './articles.ts'
import { fetchMoods, type Mood } from './moods.ts'
import { fetchRewrite, factCheckSummary, type Rewrite } from './rewrite.ts'
import { useRoute } from './route.ts'
import { AnchorMark, ArrowBack, ArrowOut, Brace } from './notation.tsx'

// Итальянская ремарка рядом с русским названием Mood — то, чем в партитуре
// задают характер исполнения. Список Mood по-прежнему приходит с сервера
// (issue #5); здесь только подпись к уже полученному id.
const REGISTER_TERM: Record<string, string> = {
  neutral: 'senza espressione',
  joyful: 'giocoso',
  sad: 'mesto',
  ironic: 'con ironia',
  dramatic: 'drammatico',
}

// Сколько строк выпуска показывать за раз.
const PAGE = 30

// У каждой новости свой адрес, поэтому переходы — настоящие ссылки: их можно
// открыть в новой вкладке, скопировать и увидеть в статусной строке. Клик
// перехватываем только для обычного левого клика без модификаторов.
function hrefFor(link: string): string {
  return `?n=${encodeURIComponent(link)}`
}

function navigate(
  event: MouseEvent<HTMLAnchorElement>,
  link: string,
  go: (link: string) => void,
) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  go(link)
}

// Rewrite для пары «Article + Mood». Генерация ленивая и может упасть (модель
// недоступна, лимит запросов), поэтому наружу отдаём и ошибку, и способ
// повторить.
function useRewrite(link: string | undefined, mood: string) {
  const [rewrite, setRewrite] = useState<Rewrite | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // cancelled гасит гонку, если Mood переключили быстрее, чем пришёл ответ.
  useEffect(() => {
    if (link === undefined) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setRewrite(null)
    fetchRewrite(link, mood)
      .then((r) => {
        if (!cancelled) setRewrite(r)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [link, mood, attempt])

  return { rewrite, loading, error, retry: () => setAttempt(attempt + 1) }
}

function Retry(props: { onClick: () => void }) {
  return (
    <button className="retry" onClick={props.onClick}>
      Переписать ещё раз
    </button>
  )
}

// Указания исполнения над строкой. Один и тот же ряд стоит и в выпуске, и на
// странице новости.
function Registers(props: {
  moods: Mood[]
  selected: string
  onSelect: (id: string) => void
}) {
  return (
    <nav className="registers" aria-label="Настроение">
      <span className="registers-label">Исполнить</span>
      {props.moods.map((mood) => (
        <button
          key={mood.id}
          className="register"
          aria-pressed={mood.id === props.selected}
          onClick={() => props.onSelect(mood.id)}
        >
          <span className="register-name">{mood.label}</span>
          <span className="register-term">{REGISTER_TERM[mood.id] ?? ''}</span>
        </button>
      ))}
    </nav>
  )
}

// Fact Check: уцелевший Anchor — нота, потерянный — пауза. Показываем весь
// список, а не только потери: видно и что сохранено, и чего не хватает. Это
// утверждение о сохранности фактов, а не извинение, поэтому остаётся на экране.
// Провал обеих сверок (Missing Anchor и Meaning Check) больше не печатается
// абзацем под текстом: его результат теперь решает судьбу Rewrite — не пишется в
// кэш и генерится заново, — а не его вёрстку (issue #12, docs/adr/0008).
function FactCheck(props: { rewrite: Rewrite }) {
  const { rewrite } = props
  const lost = new Set(rewrite.missing.map((a) => a.text))
  return (
    <section className="factcheck">
      <span className="apparatus factcheck-count">
        {factCheckSummary(rewrite)}
      </span>
      <div className="factcheck-row">
        {rewrite.anchors.map((anchor) => (
          <AnchorMark
            key={`${anchor.kind}:${anchor.text}`}
            kept={!lost.has(anchor.text)}
            text={anchor.text}
          />
        ))}
      </div>
    </section>
  )
}

// Страница одной новости: оригинал и переписанное — два стана одной системы,
// соединённые акколадой.
function Piece(props: {
  article: Article
  index: number
  moods: Mood[]
  selected: string
  onSelect: (id: string) => void
  onBack: () => void
}) {
  const { article } = props
  const { rewrite, loading, error, retry } = useRewrite(
    article.link,
    props.selected,
  )

  return (
    <>
      <button className="back apparatus" onClick={props.onBack}>
        <ArrowBack />
        Ко всему выпуску
      </button>

      <div className="piece-head">
        <span className="mark">№ {props.index}</span>
        <span className="apparatus">{article.source}</span>
        <span className="apparatus">{formatPublished(article.publishedAt)}</span>
      </div>

      <Registers
        moods={props.moods}
        selected={props.selected}
        onSelect={props.onSelect}
      />

      <div className="system">
        <Brace />
        <div className="staves">
          <section className="stave">
            {/* Рубрика стоит слева от нотоносца, как название партии в
                партитуре, а не подписью над заголовком. */}
            <p className="stave-label">Как передал источник</p>
            <div className="stave-body">
              <h2>{article.title}</h2>
              {article.announce !== '' && <p>{article.announce}</p>}
            </div>
          </section>

          <section className="stave">
            <p className="stave-label">Переписано</p>
            <div className="stave-body">
              {loading && <p className="working">Переписываю…</p>}
              {error !== null && (
                <>
                  <p className="editorial editorial-alert">
                    переписать не удалось: {error}
                  </p>
                  <Retry onClick={retry} />
                </>
              )}
              {rewrite !== null && !loading && (
                <div className="stave-rewritten" key={rewrite.mood}>
                  <h2>{rewrite.title}</h2>
                  <p>{rewrite.body}</p>
                  {rewrite.stub && (
                    <>
                      <p className="editorial">
                        модель недоступна, поэтому показан исходный текст без
                        изменений
                      </p>
                      <Retry onClick={retry} />
                    </>
                  )}
                  <FactCheck rewrite={rewrite} />
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <footer className="fine">
        <a
          className="source-link"
          href={article.link}
          target="_blank"
          rel="noreferrer"
        >
          Читать в источнике: {article.source}
          <ArrowOut />
        </a>
        <span className="apparatus">
          Оригинал не редактируется — меняется только тон
        </span>
      </footer>
    </>
  )
}

// Главная новость на плашке. Выпуск — это оглавление: здесь стоит только
// заголовок источника. Rewrite звучит на странице новости, где рядом виден
// оригинал и сверка, — переписывать вслепую с оглавления нельзя.
function Lead(props: { article: Article; onOpen: (link: string) => void }) {
  const { article } = props

  return (
    <a
      className="lead"
      href={hrefFor(article.link)}
      onClick={(e) => navigate(e, article.link, props.onOpen)}
    >
      <span className="lead-head">
        <span className="mark">№ 1</span>
      </span>
      <span className="lead-body">
        <h2>{article.title}</h2>
      </span>
      <span className="lead-foot apparatus">
        <span>{article.source}</span>
        <span>{formatPublished(article.publishedAt)}</span>
      </span>
    </a>
  )
}

// Выпуск: главная новость на плашке, остальные — строками стана. Регистры
// сюда не ставим: выбирать Mood можно только там, где его слышно.
function Issue(props: {
  articles: Article[]
  onOpen: (link: string) => void
}) {
  const [lead, ...rest] = props.articles
  // В базе накапливаются сотни Article: выпуск показывает первую страницу и
  // догружает остальное по требованию, иначе страница уходит в бесконечность.
  const [shown, setShown] = useState(PAGE)
  const page = rest.slice(0, shown)

  return (
    <>
      {lead === undefined ? (
        <p className="empty">
          Стан пуст: выпуск ещё не набран. Нажмите «Обновить», чтобы забрать
          свежие новости из лент.
        </p>
      ) : (
        <>
          <Lead article={lead} onOpen={props.onOpen} />

          <div className="staff">
            {page.map((article, i) => (
              <a
                key={article.link}
                className={i < 3 ? 'entry rank-major' : 'entry rank-minor'}
                href={hrefFor(article.link)}
                onClick={(e) => navigate(e, article.link, props.onOpen)}
              >
                <span className="entry-clef apparatus">
                  <span>№ {i + 2}</span>
                  <span>{article.source}</span>
                </span>
                <span>
                  <h2>{article.title}</h2>
                </span>
                <span className="entry-time apparatus">
                  {formatShort(article.publishedAt)}
                </span>
              </a>
            ))}
          </div>

          {shown < rest.length && (
            <button className="more" onClick={() => setShown(shown + PAGE)}>
              Дальше по выпуску
              <span className="apparatus">
                показано {page.length + 1} из {props.articles.length}
              </span>
            </button>
          )}
        </>
      )}
    </>
  )
}

export function App() {
  const [articles, setArticles] = useState<Article[]>([])
  const [moods, setMoods] = useState<Mood[]>([])
  const [selectedMood, setSelectedMood] = useState('neutral')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [openLink, go] = useRoute()

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

  const openIndex = articles.findIndex((a) => a.link === openLink)
  const open = openIndex === -1 ? null : articles[openIndex]
  const currentTerm = REGISTER_TERM[selectedMood] ?? ''

  return (
    <main className="sheet">
      <header>
        <div className="masthead">
          <div>
            {/* Ремарка регистра стоит только там, где регистр выбирают, —
                на странице новости. В выпуске ей нечего описывать. */}
            {open !== null && <p className="masthead-note">{currentTerm}</p>}
            <h1>
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault()
                  go(null)
                }}
              >
                Mood News
              </a>
            </h1>
          </div>
          <button
            className="refresh"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            {refreshing ? 'Забираю…' : 'Обновить'}
          </button>
        </div>
        <div className="double-barline" />
      </header>

      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && (
        <p className="editorial editorial-alert">ошибка: {error}</p>
      )}

      {openLink !== null && open === null && articles.length > 0 && (
        <p className="editorial editorial-alert">
          такой новости в выпуске нет — возможно, она уже ушла из ленты
        </p>
      )}

      {open === null ? (
        <Issue articles={articles} onOpen={(link) => go(link)} />
      ) : (
        <Piece
          article={open}
          index={openIndex + 1}
          moods={moods}
          selected={selectedMood}
          onSelect={setSelectedMood}
          onBack={() => go(null)}
        />
      )}
    </main>
  )
}
