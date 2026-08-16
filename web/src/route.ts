import { useEffect, useState } from 'react'

// У страницы новости свой адрес (?n=<ссылка Article>), чтобы её можно было
// скинуть ссылкой. Состояний ровно два — выпуск и одна новость, — поэтому
// роутинг живёт на History API, без библиотеки.
function readLink(): string | null {
  return new URLSearchParams(window.location.search).get('n')
}

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
        : `${window.location.pathname}?n=${encodeURIComponent(next)}`
    window.history.pushState(null, '', url)
    setLink(next)
    window.scrollTo(0, 0)
  }

  return [link, go]
}
