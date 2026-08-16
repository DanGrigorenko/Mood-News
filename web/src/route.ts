import { useEffect, useState } from 'react'
import { newsHref, readNewsLink } from './address.ts'

// У страницы новости свой адрес (?n=<ссылка Article>), чтобы её можно было
// скинуть ссылкой. Состояний ровно два — выпуск и одна новость, — поэтому
// роутинг живёт на History API, без библиотеки. Формат адреса описан один раз в
// address.ts: здесь только чтение History API и pushState.
const readLink = () => readNewsLink(window.location.search)

export function useRoute(): [string | null, (link: string | null) => void] {
  const [link, setLink] = useState<string | null>(readLink)

  useEffect(() => {
    const onPop = () => setLink(readLink())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function go(next: string | null) {
    const url =
      next === null
        ? window.location.pathname
        : `${window.location.pathname}${newsHref(next)}`
    window.history.pushState(null, '', url)
    setLink(next)
    window.scrollTo(0, 0)
  }

  return [link, go]
}
