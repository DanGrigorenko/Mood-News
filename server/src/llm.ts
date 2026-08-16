import { z } from 'zod'
import type { Anchor } from './anchor.ts'
import { type Mood, MOOD_REGISTER } from './mood.ts'

// Обращение к модели идёт по OpenAI-совместимому HTTP: LLM_BASE_URL, LLM_MODEL и
// LLM_API_KEY берутся из окружения (.env в корне, через --env-file-if-exists),
// чтобы z.ai/GLM, OpenRouter и Groq подключались сменой трёх переменных.

export type ChatMessage = { role: 'system' | 'user'; content: string }

// Модель обязана вернуть JSON ровно такой формы. Невалидный JSON или нехватка
// полей — это просто ещё одна неудачная попытка (см. parseModelContent).
const modelOutputSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})
export type ModelOutput = z.infer<typeof modelOutputSchema>

// Вызов модели: сообщения → распарсенный вывод, либо null, если модель вернула
// не-JSON. Сетевые ошибки и таймаут бросаются (их показывают читателю как
// внятную ошибку, а не молча ретраят).
export type ModelCall = (messages: ChatMessage[]) => Promise<ModelOutput | null>

// Вердикт Meaning Check — смысловой сверки (docs/adr/0005, docs/adr/0007).
// consistent:true — исход события (Outcome) сохранён; false — найдено искажение
// (Distortion), и distortion называет его.
const meaningCheckOutputSchema = z.object({
  consistent: z.boolean(),
  distortion: z.string(),
})
export type MeaningCheckOutput = z.infer<typeof meaningCheckOutputSchema>

// Вызов судьи Meaning Check: сообщения → вердикт, либо null при не-JSON.
// Сетевые ошибки и таймаут, как и у ModelCall, бросаются.
export type MeaningCheckCall = (messages: ChatMessage[]) => Promise<MeaningCheckOutput | null>

function anchorList(anchors: Anchor[]): string {
  return anchors.map((a) => `«${a.text}»`).join(', ')
}

// Anchor вида name сверяется isPresent по первым пяти символам — падеж нам
// безразличен (см. anchor.ts). Промпт же требовал их дословно, в исходной форме,
// и тем самым диктовал конструкцию всей фразы. Требование дословности
// расщепляется по виду Anchor: числа, даты, суммы и цитаты — дословно; имена
// собственные — обязательны, но склонять их разрешено (issue #13).
function verbatimAnchors(anchors: Anchor[]): Anchor[] {
  return anchors.filter((a) => a.kind !== 'name')
}
function nameAnchors(anchors: Anchor[]): Anchor[] {
  return anchors.filter((a) => a.kind === 'name')
}

// Промпт задаёт эмоциональный регистр и жёсткие правила сохранности фактов.
// Явный список Anchor кладётся в запрос: они обязаны присутствовать дословно.
// Числа и даты — только цифрами, иначе детерминированная сверка разваливается
// (см. docs/adr/0002).
export function buildMessages(opts: {
  mood: Mood
  title: string
  announce: string
  anchors: Anchor[]
  missing: Anchor[]
  // Прошлая попытка вернула текст источника без изменений — просим переписать
  // по-настоящему (issue #8).
  unchanged?: boolean
  // Прошлая попытка исказила исход — Meaning Check назвал Distortion, и мы
  // сообщаем его модели, чтобы ретрай не был слепой перегенерацией (issue #10).
  distortion?: string
}): ChatMessage[] {
  const rules = [
    'Не добавляй фактов, которых нет в исходном тексте.',
    'Не меняй числа, имена, даты, места и суммы.',
    'Не выдумывай цитат.',
    'Числа и даты пиши цифрами, а не прописью: «15%», а не «пятнадцать процентов»; «2026», а не «две тысячи двадцать шестой».',
    // Outcome неизменяем наравне с Anchor (docs/adr/0007): исход события —
    // направление, результат и субъект — сохраняется как в источнике. Радость
    // это позиция рассказчика, а не переоценка события.
    'Не переворачивай исход события: упало значит упало, погиб значит погиб, отклонено значит отклонено. Направление, результат и того, кто совершил действие, не меняй — даже ради регистра.',
    // Общий пол на все Mood.
    'Не глумись над пострадавшими: над бедой людей не насмешничай, регистр — это тон рассказчика, а не издёвка над теми, кому плохо.',
    // Приписка вида «ЦСКА. Мойзесу. Новости.» в конце — попытка удовлетворить
    // дословность в обход переписывания. Называем это явно (issue #13).
    'Не приписывай факты списком или перечнем в конце текста: факты должны быть вплетены в связные предложения, а не свалены отдельными словами.',
    'Верни простой текст без markdown-разметки: без звёздочек **, подчёркиваний _ и решёток #.',
  ]
  const verbatim = verbatimAnchors(opts.anchors)
  const names = nameAnchors(opts.anchors)
  if (verbatim.length > 0) {
    rules.push(
      `Эти фрагменты — числа, даты, суммы, цитаты — обязаны присутствовать в ответе ДОСЛОВНО: ${anchorList(verbatim)}.`,
    )
  }
  if (names.length > 0) {
    rules.push(
      `Эти имена собственные обязаны присутствовать, но их можно склонять — менять падеж, число и род по смыслу фразы: ${anchorList(names)}.`,
    )
  }

  const system = [
    'Ты переписываешь новость в заданном эмоциональном регистре, не меняя фактов.',
    `Регистр: ${MOOD_REGISTER[opts.mood]}`,
    'Жёсткие правила:',
    ...rules.map((r) => `- ${r}`),
    'Верни строго JSON вида {"title": "...", "body": "..."} без пояснений.',
  ].join('\n')

  const userParts = [`Заголовок: ${opts.title}`, `Текст: ${opts.announce}`]
  if (opts.missing.length > 0) {
    // Тот же раскол по виду Anchor, что и в правилах: числа/даты/цитаты — верни
    // дословно, имена — верни, но склонять их можно (issue #13).
    const missingVerbatim = verbatimAnchors(opts.missing)
    const missingNames = nameAnchors(opts.missing)
    if (missingVerbatim.length > 0) {
      userParts.push(
        `В прошлой попытке потеряны обязательные фрагменты — верни их дословно: ${anchorList(missingVerbatim)}.`,
      )
    }
    if (missingNames.length > 0) {
      userParts.push(
        `В прошлой попытке потеряны имена — верни их, склонять можно: ${anchorList(missingNames)}.`,
      )
    }
  }
  if (opts.unchanged) {
    userParts.push(
      'В прошлой попытке ты вернул текст источника без изменений — это не переписывание. Перепиши его заново в заданном регистре: смени формулировки, порядок и подачу, сохранив все факты.',
    )
  }
  if (opts.distortion) {
    userParts.push(
      `В прошлой попытке был искажён исход события (Outcome): ${opts.distortion}. Исправь именно это, сохранив исход события и все факты; тон при этом можно оставить прежним.`,
    )
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ]
}

// Промпт Meaning Check: судья сверяет Rewrite с исходным Snippet на сохранность
// исхода события (Outcome), а не тона (docs/adr/0005, docs/adr/0007). Проверяется
// направление, результат и субъект события плюс отсутствие дорисованных фактов;
// эмоциональная окраска — законная задача Rewrite, придираться к ней судья не
// должен. Ложное срабатывание дороже пропуска — оно убивает валидный Rewrite и
// жжёт попытку, поэтому при сомнении вердикт consistent:true.
export function buildMeaningCheckMessages(opts: {
  title: string
  announce: string
  rewrite: ModelOutput
}): ChatMessage[] {
  const system = [
    'Ты сверяешь переписанную новость с её оригиналом на сохранность исхода события (Outcome), а не тона.',
    'Найди в переписанном тексте искажение исхода (Distortion): изменённое направление или результат события (погиб/выжил, вырос/упал, принято/отклонено), подменённое действующее лицо (кто совершил действие) или добавленный факт, которого в оригинале нет.',
    'Разные словоформы одного и того же слова (падеж, число, род: «Проскурина» и «Проскурину», «продажи» и «продаж») — это НЕ подмена субъекта. Считай подменой лишь замену одного лица или предмета на другое.',
    'Проверяй ТОЛЬКО исход события и факты. НЕ придирайся к эмоциональной окраске, тону, выбору слов и оценкам — менять тон разрешено, это и есть задача переписывания. Смена тона при сохранённом исходе искажением НЕ считается.',
    'Если сомневаешься, искажён исход или нет, — вердикт consistent:true. Ложная тревога убивает годный текст, поэтому наказывай только явное искажение.',
    'Верни строго JSON. Если исход сохранён: {"consistent": true, "distortion": ""}. Если искажён: {"consistent": false, "distortion": "кратко назови искажённое"}.',
  ].join('\n')

  const user = [
    'Оригинал:',
    `Заголовок: ${opts.title}`,
    `Текст: ${opts.announce}`,
    '',
    'Переписанный текст:',
    `Заголовок: ${opts.rewrite.title}`,
    `Текст: ${opts.rewrite.body}`,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

// Нижняя и верхняя границы max_tokens. Нижняя — прежние 400: короткому Snippet
// больше не нужно. Верхняя — потолок против случайного пробоя бюджета на
// аномально длинном входе. max_tokens — это потолок, а не резервирование,
// поэтому большой лимит судье не вредит: формула общая для обоих вызовов.
const MIN_MAX_TOKENS = 400
const MAX_MAX_TOKENS = 2000

// Rewrite сопоставим по длине с источником, а после docs/adr/0006 Snippet — это
// полный текст статьи, а не анонс из ленты. Поэтому max_tokens выводится из
// объёма входа с запасом (≈ на четверть символа токен, ×1.5 на переписывание),
// а не держится константой, которую пришлось бы трогать при каждой смене
// источника. Границы — MIN_MAX_TOKENS…MAX_MAX_TOKENS.
export function maxTokensFor(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0)
  const estimated = Math.ceil((chars / 4) * 1.5)
  return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, estimated))
}

// Тело запроса к OpenAI-совместимому эндпоинту. Две детали, проверенные на живом
// API (см. issue): "thinking": disabled обязателен, иначе весь бюджет токенов
// уходит в reasoning и content возвращается пустым; response_format json_object
// даёт валидный JSON без обрамления ```json. max_tokens считается от длины входа
// (issue #12): полный текст статьи не обрывается на середине предложения.
export function buildRequestBody(messages: ChatMessage[], model: string) {
  return {
    model,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    max_tokens: maxTokensFor(messages),
    messages,
  }
}

// Вычистка markdown-разметки — самая высокая точка разбора ответа модели
// (issue #12): ниже неё вывод видят и Fact Check, и кэш, и экран. Одна правка
// закрывает и «**Россия**» в вёрстке, и поломанную сверку цитат (Anchor вида
// quote терял бы исходную подстроку внутри «**…**»). Снимаются маркеры
// выделения (*, _, `) и заголовков (# в начале строки). Это чистка символов, а
// не разбор markdown: текст, где звёздочка была частью содержания, пострадает —
// поэтому промпт дополнительно просит простой текст без разметки.
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // заголовки # в начале строки
    .replace(/[*_`]/g, '') // маркеры выделения
}

// Разбор content из ответа модели. Невалидный JSON или неполный объект — null:
// в цикле генерации это ещё одна неудачная попытка, а не сбой. markdown из
// title и body вычищается здесь, в единой точке разбора (issue #12).
export function parseModelContent(content: string): ModelOutput | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = modelOutputSchema.safeParse(json)
  if (!result.success) return null
  return {
    title: stripMarkdown(result.data.title),
    body: stripMarkdown(result.data.body),
  }
}

// Разбор вердикта Meaning Check. Не-JSON или неполный объект — null: в цикле
// генерации это значит «сверка не дала ответа», проверка честно помечается
// непройденной, а не выдаётся за пройденную (docs/adr/0005).
export function parseMeaningCheckContent(content: string): MeaningCheckOutput | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = meaningCheckOutputSchema.safeParse(json)
  return result.success ? result.data : null
}

// Ответ chat/completions: нам нужен только текст первого choice.
const chatResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
})

export function llmConfig(): { baseUrl: string; model: string; apiKey: string } {
  return {
    baseUrl: (process.env.LLM_BASE_URL ?? '').replace(/\/$/, ''),
    model: process.env.LLM_MODEL ?? '',
    apiKey: (process.env.LLM_API_KEY ?? '').trim(),
  }
}

// Пустой LLM_API_KEY — режим заглушки: модель не вызывается вовсе.
export function hasApiKey(): boolean {
  return llmConfig().apiKey !== ''
}

const REQUEST_TIMEOUT_MS = 30_000

// Общая HTTP-обвязка обоих вызовов: POST на /chat/completions и разбор ответа до
// content первого choice. label подставляется в текст ошибок («модель
// недоступна», «смысловая сверка ответила 500») — оба существительных женского
// рода, поэтому формулировки согласуются. Недоступность, таймаут и не-2xx бросают
// Error; иначе возвращается сырой content для разбора вызывающим.
async function fetchChatContent(messages: ChatMessage[], label: string): Promise<string> {
  const { baseUrl, model, apiKey } = llmConfig()

  let res: Response
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(messages, model)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${label} недоступна: ${reason}`)
  }

  if (!res.ok) {
    throw new Error(`${label} ответила ${res.status}`)
  }

  const parsed = chatResponseSchema.safeParse(await res.json())
  if (!parsed.success) {
    throw new Error(`${label} вернула ответ неожиданной формы`)
  }
  return parsed.data.choices[0]!.message.content
}

// Реальный вызов модели по HTTP. Недоступность, таймаут и не-2xx бросают
// Error с внятным текстом; не-JSON content возвращает null (неудачная попытка).
export async function callModelOverHttp(messages: ChatMessage[]): Promise<ModelOutput | null> {
  return parseModelContent(await fetchChatContent(messages, 'модель'))
}

// Реальный вызов судьи Meaning Check по HTTP. Та же обвязка, что и у
// callModelOverHttp; не-JSON content возвращает null. Бросок наверху ловится
// generateRewrite и превращается в честную пометку «сверка не проведена» —
// запрос при этом не падает целиком.
export async function callMeaningCheckOverHttp(
  messages: ChatMessage[],
): Promise<MeaningCheckOutput | null> {
  return parseMeaningCheckContent(await fetchChatContent(messages, 'смысловая сверка'))
}
