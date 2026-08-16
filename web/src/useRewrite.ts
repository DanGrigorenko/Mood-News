import { fetchRewrite, type Rewrite } from './rewrite.ts'

// Состояние Rewrite для пары «Article + Mood»: текущий результат, идёт ли
// генерация, и ошибка, если модель недоступна. Ровно то, что показывает экран —
// interface наружу без React и без DOM, поэтому переход состояния проверяется
// тестом (issue #25, PRD #18).
export type RewriteState = {
  rewrite: Rewrite | null
  loading: boolean
  error: string | null
}

const IDLE: RewriteState = { rewrite: null, loading: false, error: null }

// Способ сходить за одним Rewrite. По умолчанию — общий fetchRewrite (тикет
// контракта, #24): он ходит на /api/articles/:id и разбирает ответ общей схемой.
// В тестах подставляется подставная функция, чтобы гонку, ошибку и повтор
// проверять без сети.
export type RewriteFetch = (link: string, mood: string) => Promise<Rewrite>

// Хранилище состояния Rewrite: подписка для представления, выбор пары и повтор.
// React-хук useRewrite (App.tsx) — тонкая обвязка над ним; вся логика здесь.
export type RewriteStore = {
  getState: () => RewriteState
  subscribe: (listener: () => void) => () => void
  select: (link: string, mood: string) => void
  retry: () => void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createRewriteStore(
  fetchOne: RewriteFetch = fetchRewrite,
): RewriteStore {
  let state = IDLE
  const listeners = new Set<() => void>()

  // token отмечает живой запрос. Каждый select/retry увеличивает его; ответ
  // применяется, только если его token всё ещё живой. Так ответ, пришедший для
  // пары, которую больше не выбирают (Mood переключили быстрее, чем пришёл
  // ответ), отбрасывается — на экран он не попадает, и Rewrite предыдущего
  // регистра не мелькает.
  let token = 0
  let last: { link: string; mood: string } | null = null

  function set(next: RewriteState) {
    state = next
    for (const listener of listeners) listener()
  }

  function request(link: string, mood: string) {
    last = { link, mood }
    const mine = ++token
    set({ rewrite: null, loading: true, error: null })
    fetchOne(link, mood).then(
      (rewrite) => {
        if (mine === token) set({ rewrite, loading: false, error: null })
      },
      (err: unknown) => {
        if (mine === token)
          set({ rewrite: null, loading: false, error: messageOf(err) })
      },
    )
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    select: request,
    retry() {
      if (last !== null) request(last.link, last.mood)
    },
  }
}
