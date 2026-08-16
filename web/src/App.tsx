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
// список, а не только потери: видно и что сохранено, и чего не хватает
// (ADR 0003).
function FactCheck(props: { rewrite: Rewrite }) {
  const lost = new Set(props.rewrite.missing.map((a) => a.text))
  return (
    <section className="factcheck">
      <span className="apparatus factcheck-count">
        {factCheckSummary(props.rewrite)}
      </span>
      <div className="factcheck-row">
        {props.rewrite.anchors.map((anchor) => (
          <AnchorMark
            key={`${anchor.kind}:${anchor.text}`}
            kept={!lost.has(anchor.text)}
            text={anchor.text}
          />
        ))}
      </div>
      {props.rewrite.missing.length > 0 && (
        <p className="factcheck-lost">
          На месте пауз должны были звучать факты — значит, переписывание их
          потеряло. Текст всё равно показан: мы не прячем промах.
        </p>
      )}
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

// Главная новость на плашке. Она и есть демонстрация: заголовок и текст на
// плашке звучат в выбранном регистре, поэтому переключатель в выпуске меняет
// саму новость, а не только подпись.
function Lead(props: {
  article: Article
  selected: string
  onOpen: (link: string) => void
}) {
  const { article } = props
  const { rewrite, loading, error, retry } = useRewrite(
    article.link,
    props.selected,
  )
  // Заглушка — это не исполнение: текст пришёл как у источника, поэтому ремарку
  // регистра над ним ставить нельзя, иначе плашка соврёт читателю.
  const performed = rewrite !== null && !loading && !rewrite.stub

  return (
    <>
      <a
        className="lead"
        href={hrefFor(article.link)}
        onClick={(e) => navigate(e, article.link, props.onOpen)}
      >
        <span className="lead-head">
          <span className="mark">№ 1</span>
          {performed && (
            <span className="lead-term">{REGISTER_TERM[props.selected]}</span>
          )}
        </span>
        <span className="lead-body" key={performed ? rewrite.mood : 'source'}>
          <h2>{performed ? rewrite.title : article.title}</h2>
          {performed ? (
            <p>{rewrite.body}</p>
          ) : (
            article.announce !== '' && <p>{article.announce}</p>
          )}
        </span>
        <span className="lead-foot apparatus">
          <span>{article.source}</span>
          <span>{formatPublished(article.publishedAt)}</span>
          {performed && <span>оригинал — на странице новости</span>}
        </span>
      </a>

      {loading && <p className="notice">Переписываю главную новость…</p>}
      {error !== null && (
        <div>
          <p className="notice">
            Переписать главную не удалось ({error}) — показан текст источника.
          </p>
          <Retry onClick={retry} />
        </div>
      )}
      {rewrite !== null && rewrite.stub && (
        <div>
          <p className="notice">
            Модель недоступна — главная показана как у источника.
          </p>
          <Retry onClick={retry} />
        </div>
      )}
    </>
  )
}

// Выпуск: главная новость на плашке, остальные — строками стана.
function Issue(props: {
  articles: Article[]
  moods: Mood[]
  selected: string
  onSelect: (id: string) => void
  onOpen: (link: string) => void
}) {
  const [lead, ...rest] = props.articles
  // В базе накапливаются сотни Article: выпуск показывает первую страницу и
  // догружает остальное по требованию, иначе страница уходит в бесконечность.
  const [shown, setShown] = useState(PAGE)
  const page = rest.slice(0, shown)

  return (
    <>
      <Registers
        moods={props.moods}
        selected={props.selected}
        onSelect={props.onSelect}
      />

      {lead === undefined ? (
        <p className="empty">
          Стан пуст: выпуск ещё не набран. Нажмите «Обновить», чтобы забрать
          свежие новости из лент.
        </p>
      ) : (
        <>
          <Lead
            article={lead}
            selected={props.selected}
            onOpen={props.onOpen}
          />

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
                  {i < 3 && article.announce !== '' && <p>{article.announce}</p>}
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
            <p className="masthead-note">{currentTerm}</p>
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
        <Issue
          articles={articles}
          moods={moods}
          selected={selectedMood}
          onSelect={setSelectedMood}
          onOpen={(link) => go(link)}
        />
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
