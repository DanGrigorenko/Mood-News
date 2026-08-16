import { z } from 'zod'
import {
  buildMessages,
  buildMeaningCheckMessages,
  type ChatMessage,
  type RewriteBrief,
  type MeaningCheckBrief,
} from './prompt.ts'

// Транспорт к модели: OpenAI-совместимый HTTP. LLM_BASE_URL, LLM_MODEL и
// LLM_API_KEY берутся из окружения (.env в корне, через --env-file-if-exists),
// чтобы z.ai/GLM, OpenRouter и Groq подключались сменой трёх переменных. Текст
// обращений живёт в prompt.ts: этот module строит из Brief сообщения чат-API и
// уносит их в сеть, а сам русского текста промптов не знает (issue #21, PRD #18).

// Модель обязана вернуть JSON ровно такой формы. Невалидный JSON или нехватка
// полей — это просто ещё одна неудачная попытка (см. parseModelContent).
const modelOutputSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})
export type ModelOutput = z.infer<typeof modelOutputSchema>

// Вызов модели: Brief в терминах домена → распарсенный вывод, либо null, если
// модель вернула не-JSON. Форма сообщений чат-API за этот seam не выходит — её
// строит adapter из Brief (issue #21). Сетевые ошибки и таймаут бросаются (их
// показывают читателю как внятную ошибку, а не молча ретраят).
export type ModelCall = (brief: RewriteBrief) => Promise<ModelOutput | null>

// Вердикт Meaning Check — смысловой сверки (docs/adr/0005, docs/adr/0007).
// consistent:true — исход события (Outcome) сохранён; false — найдено искажение
// (Distortion), и distortion называет его.
const meaningCheckOutputSchema = z.object({
  consistent: z.boolean(),
  distortion: z.string(),
})
export type MeaningCheckOutput = z.infer<typeof meaningCheckOutputSchema>

// Вызов судьи Meaning Check: Brief → вердикт, либо null при не-JSON. Как и у
// ModelCall, сообщения чат-API за seam не выходят. Сетевые ошибки и таймаут
// бросаются.
export type MeaningCheckCall = (brief: MeaningCheckBrief) => Promise<MeaningCheckOutput | null>

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

// Провайдер режет частые запросы 429, и на живом корпусе это стоило 6 из 50
// несостоявшихся смысловых сверок: судья молчал, Rewrite уходил с пометкой
// «не проверено». 429 и 5xx — это «повтори позже», а не «не выйдет», поэтому
// повторяем с растущей паузой. Клиентские ошибки (401, 400) не повторяем: они
// не пройдут и на десятый раз.
const RETRY_STATUSES = (status: number): boolean => status === 429 || status >= 500
const RETRY_DELAYS_MS = [1_000, 4_000, 10_000]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Общая HTTP-обвязка обоих вызовов: POST на /chat/completions и разбор ответа до
// content первого choice. label подставляется в текст ошибок («модель
// недоступна», «смысловая сверка ответила 500») — оба существительных женского
// рода, поэтому формулировки согласуются. Недоступность, таймаут и не-2xx бросают
// Error; иначе возвращается сырой content для разбора вызывающим.
async function fetchChatContent(messages: ChatMessage[], label: string): Promise<string> {
  const { baseUrl, model, apiKey } = llmConfig()

  let res: Response | null = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
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
    if (res.ok || !RETRY_STATUSES(res.status)) break
    const pause = RETRY_DELAYS_MS[attempt]
    if (pause === undefined) break // попытки кончились — отдаём последний ответ
    await sleep(pause)
  }

  if (res === null || !res.ok) {
    throw new Error(`${label} ответила ${res?.status ?? 'молчанием'}`)
  }

  const parsed = chatResponseSchema.safeParse(await res.json())
  if (!parsed.success) {
    throw new Error(`${label} вернула ответ неожиданной формы`)
  }
  return parsed.data.choices[0]!.message.content
}

// Реальный вызов модели по HTTP: Brief → сообщения чат-API строятся здесь, за
// seam, и уносятся в сеть. Недоступность, таймаут и не-2xx бросают Error с
// внятным текстом; не-JSON content возвращает null (неудачная попытка).
export async function callModelOverHttp(brief: RewriteBrief): Promise<ModelOutput | null> {
  return parseModelContent(await fetchChatContent(buildMessages(brief), 'модель'))
}

// Реальный вызов судьи Meaning Check по HTTP. Та же обвязка, что и у
// callModelOverHttp; не-JSON content возвращает null. Бросок наверху ловится
// generateRewrite и превращается в честную пометку «сверка не проведена» —
// запрос при этом не падает целиком.
export async function callMeaningCheckOverHttp(
  brief: MeaningCheckBrief,
): Promise<MeaningCheckOutput | null> {
  return parseMeaningCheckContent(
    await fetchChatContent(buildMeaningCheckMessages(brief), 'смысловая сверка'),
  )
}
