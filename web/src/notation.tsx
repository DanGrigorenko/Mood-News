// Нотные знаки мира «Партитура». Всё рисуется SVG, а не набирается юникодными
// символами: у музыкальных глифов в системных шрифтах разный кегль и разная
// толщина штриха, и строка из них рассыпается.

// Акколада — фигурная скобка, соединяющая оригинал и переписанное в одну
// систему. Тянется по высоте системы, толщина штриха при этом не плывёт.
export function Brace() {
  return (
    <svg
      className="brace"
      viewBox="0 0 14 200"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 2 C 5 20, 11 76, 2 100 C 11 124, 5 180, 12 198"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// Уцелевший Anchor — нота: головка со штилем, стоящая на линейке.
function Notehead() {
  return (
    <svg width="20" height="26" viewBox="0 0 20 26" aria-hidden="true" focusable="false">
      <line x1="15.4" y1="18" x2="15.4" y2="2" stroke="currentColor" strokeWidth="1.6" />
      <ellipse
        cx="10"
        cy="18"
        rx="5.4"
        ry="3.9"
        fill="currentColor"
        transform="rotate(-22 10 18)"
      />
    </svg>
  )
}

// Потерянный Anchor — пауза: молчание ровно там, где должен был звучать факт.
function Rest() {
  return (
    <svg width="20" height="26" viewBox="0 0 20 26" aria-hidden="true" focusable="false">
      <line x1="3" y1="13" x2="17" y2="13" stroke="currentColor" strokeWidth="1" />
      <rect x="5.5" y="13" width="9" height="5.5" fill="currentColor" />
    </svg>
  )
}

export function AnchorMark(props: { kept: boolean; text: string }) {
  return (
    <span className={props.kept ? 'anchor' : 'anchor anchor-lost'}>
      {props.kept ? <Notehead /> : <Rest />}
      <span className="anchor-text">{props.text}</span>
    </span>
  )
}

export function ArrowOut() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
      <path
        d="M3.5 9.5 L9.5 3.5 M4.6 3.5 H9.5 V8.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ArrowBack() {
  return (
    <svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true" focusable="false">
      <path
        d="M13.5 6.5 H2 M6.5 2 L2 6.5 L6.5 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
