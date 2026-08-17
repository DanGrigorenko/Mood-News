import { fetchArticles, runIngest, formatAdded } from './articles.ts'
import type { Article, IngestResult } from '../../shared/api.mts'

// Состояние Выпуска на фронте: список Article, человеческое уведомление после
// Ingest, ошибка загрузки и признак «идёт обновление». Ровно то, что показывает
// экран — interface наружу без React и без DOM, поэтому переход состояния
// («Обновить» дало уведомление, провал снял признак, провал загрузки не стёр
// список) проверяется тестом (issue #31, PRD #26), тем же приёмом, что у
// хранилища Rewrite (useRewrite.ts).
export type IssueState = {
  articles: Article[]
  notice: string | null
  error: string | null
  refreshing: boolean
}

const IDLE: IssueState = {
  articles: [],
  notice: null,
  error: null,
  refreshing: false,
}

// Способы сходить в API — зависимости со значениями по умолчанию, как
// fetchRewrite у хранилища Rewrite. В проде — общие fetchArticles/runIngest, в
// тестах — подставные, чтобы переход состояния проверять без сети.
export type IssueDeps = {
  fetchArticles: () => Promise<Article[]>
  runIngest: () => Promise<IngestResult>
}

// Хранилище состояния Выпуска: подписка для представления, загрузка списка и
// обновление (Ingest плюс перечитывание). React-обвязка в App.tsx — тонкая
// подписка на него; вся логика здесь.
export type IssueStore = {
  getState: () => IssueState
  subscribe: (listener: () => void) => () => void
  load: () => Promise<void>
  refresh: () => Promise<void>
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createIssueStore(deps: Partial<IssueDeps> = {}): IssueStore {
  const fetchList = deps.fetchArticles ?? fetchArticles
  const ingest = deps.runIngest ?? runIngest

  let state = IDLE
  const listeners = new Set<() => void>()

  function set(next: IssueState) {
    state = next
    for (const listener of listeners) listener()
  }

  // Перечитывание списка. Провал не стирает уже показанный список: на экране
  // остаётся прежний выпуск, а не пустой стан, — падение ленты не выглядит как
  // «новостей нет».
  async function load() {
    try {
      const articles = await fetchList()
      set({ ...state, articles, error: null })
    } catch (err: unknown) {
      set({ ...state, error: messageOf(err) })
    }
  }

  // Обновление: Ingest забирает свежие новости, уведомление показывает, сколько
  // добавлено и отброшено, затем список перечитывается. Провал на любом шаге
  // кладёт ошибку; признак «идёт обновление» снимается в любом исходе.
  async function refresh() {
    set({ ...state, refreshing: true, notice: null })
    try {
      const { added, skipped } = await ingest()
      set({ ...state, notice: formatAdded(added, skipped) })
      await load()
    } catch (err: unknown) {
      set({ ...state, error: messageOf(err) })
    } finally {
      set({ ...state, refreshing: false })
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load,
    refresh,
  }
}
