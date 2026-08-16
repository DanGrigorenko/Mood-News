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

// Вердикт второго прохода — смысловой сверки (docs/adr/0005). consistent:true —
// противоречий с источником нет; false — есть, и contradiction называет его.
const reviewOutputSchema = z.object({
  consistent: z.boolean(),
  contradiction: z.string(),
})
export type ReviewOutput = z.infer<typeof reviewOutputSchema>

// Вызов судьи второго прохода: сообщения → вердикт, либо null при не-JSON.
// Сетевые ошибки и таймаут, как и у ModelCall, бросаются.
export type ReviewCall = (messages: ChatMessage[]) => Promise<ReviewOutput | null>

function anchorList(anchors: Anchor[]): string {
  return anchors.map((a) => `«${a.text}»`).join(', ')
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
  // Прошлая попытка исказила смысл — второй проход назвал противоречие, и мы
  // сообщаем его модели, чтобы ретрай не был слепой перегенерацией (issue #10).
  contradiction?: string
}): ChatMessage[] {
  const rules = [
    'Не добавляй фактов, которых нет в исходном тексте.',
    'Не меняй числа, имена, даты, места и суммы.',
    'Не выдумывай цитат.',
    'Числа и даты пиши цифрами, а не прописью: «15%», а не «пятнадцать процентов»; «2026», а не «две тысячи двадцать шестой».',
  ]
  if (opts.anchors.length > 0) {
    rules.push(
      `Эти фрагменты обязаны присутствовать в ответе ДОСЛОВНО: ${anchorList(opts.anchors)}.`,
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
    userParts.push(
      `В прошлой попытке потеряны обязательные фрагменты — верни их дословно: ${anchorList(opts.missing)}.`,
    )
  }
  if (opts.unchanged) {
    userParts.push(
      'В прошлой попытке ты вернул текст источника без изменений — это не переписывание. Перепиши его заново в заданном регистре: смени формулировки, порядок и подачу, сохранив все факты.',
    )
  }
  if (opts.contradiction) {
    userParts.push(
      `В прошлой попытке смысл был искажён относительно источника: ${opts.contradiction}. Исправь именно это, сохранив исход события и все факты; тон при этом можно оставить прежним.`,
    )
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ]
}

// Промпт второго прохода: судья сверяет Rewrite с исходным Snippet на сохранность
// смысла, а не тона (docs/adr/0005). Проверяется исход события и наличие
// утверждений; эмоциональная окраска — законная задача Rewrite, придираться к
// ней судья не должен.
export function buildReviewMessages(opts: {
  title: string
  announce: string
  rewrite: ModelOutput
}): ChatMessage[] {
  const system = [
    'Ты сверяешь переписанную новость с её оригиналом на сохранность смысла, а не тона.',
    'Найди в переписанном тексте утверждение, которое противоречит исходу события в оригинале или отсутствует в оригинале: изменённый исход (погиб/выжил, вырос/упал, принято/отклонено), подменённое действующее лицо, добавленный факт, которого в оригинале нет.',
    'Проверяй ТОЛЬКО суть события и факты. НЕ придирайся к эмоциональной окраске, тону, выбору слов и оценкам — менять тон разрешено, это и есть задача переписывания. Смена тона при сохранённом смысле противоречием НЕ считается.',
    'Верни строго JSON. Если противоречий нет: {"consistent": true, "contradiction": ""}. Если есть: {"consistent": false, "contradiction": "кратко назови искажённое"}.',
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

// Тело запроса к OpenAI-совместимому эндпоинту. Две детали, проверенные на живом
// API (см. issue): "thinking": disabled обязателен, иначе весь бюджет токенов
// уходит в reasoning и content возвращается пустым; response_format json_object
// даёт валидный JSON без обрамления ```json.
export function buildRequestBody(messages: ChatMessage[], model: string) {
  return {
    model,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    max_tokens: 400,
    messages,
  }
}

// Разбор content из ответа модели. Невалидный JSON или неполный объект — null:
// в цикле генерации это ещё одна неудачная попытка, а не сбой.
export function parseModelContent(content: string): ModelOutput | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = modelOutputSchema.safeParse(json)
  return result.success ? result.data : null
}

// Разбор вердикта второго прохода. Не-JSON или неполный объект — null: в цикле
// генерации это значит «сверка не дала ответа», проверка честно помечается
// непройденной, а не выдаётся за пройденную (docs/adr/0005).
export function parseReviewContent(content: string): ReviewOutput | null {
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch {
    return null
  }
  const result = reviewOutputSchema.safeParse(json)
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

// Реальный вызов модели по HTTP. Недоступность, таймаут и не-2xx бросают
// Error с внятным текстом; не-JSON content возвращает null (неудачная попытка).
export async function callModelOverHttp(messages: ChatMessage[]): Promise<ModelOutput | null> {
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
    throw new Error(`модель недоступна: ${reason}`)
  }

  if (!res.ok) {
    throw new Error(`модель ответила ${res.status}`)
  }

  const parsed = chatResponseSchema.safeParse(await res.json())
  if (!parsed.success) {
    throw new Error('модель вернула ответ неожиданной формы')
  }
  return parseModelContent(parsed.data.choices[0]!.message.content)
}

// Реальный вызов судьи второго прохода по HTTP. Та же обвязка, что и у
// callModelOverHttp: недоступность, таймаут и не-2xx бросают Error; не-JSON
// content возвращает null. Бросок наверху ловится generateRewrite и превращается
// в честную пометку «сверка не проведена» — запрос при этом не падает целиком.
export async function callReviewOverHttp(
  messages: ChatMessage[],
): Promise<ReviewOutput | null> {
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
    throw new Error(`смысловая сверка недоступна: ${reason}`)
  }

  if (!res.ok) {
    throw new Error(`смысловая сверка ответила ${res.status}`)
  }

  const parsed = chatResponseSchema.safeParse(await res.json())
  if (!parsed.success) {
    throw new Error('смысловая сверка вернула ответ неожиданной формы')
  }
  return parseReviewContent(parsed.data.choices[0]!.message.content)
}
