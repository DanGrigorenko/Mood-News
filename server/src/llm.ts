import { z } from 'zod'
import {
  buildMessages,
  buildMeaningCheckMessages,
  type ChatMessage,
  type RewriteBrief,
  type MeaningCheckBrief,
} from './prompt.ts'
import {
  parseModelContent,
  parseMeaningCheckContent,
  type ModelOutput,
  type MeaningCheckOutput,
} from './parse.ts'

// Транспорт к модели: OpenAI-совместимый HTTP. LLM_BASE_URL, LLM_MODEL и
// LLM_API_KEY берутся из окружения (.env в корне, через --env-file-if-exists),
// чтобы z.ai/GLM, OpenRouter и Groq подключались сменой трёх переменных. Текст
// обращений живёт в prompt.ts, разбор ответа — в parse.ts: этот module строит из
// Brief сообщения чат-API и уносит их в сеть, а сам ни русского текста промптов,
// ни разбора content не знает (issue #21, #22, PRD #18).

// Вывод модели и вердикт судьи описаны в parse.ts (разбор ответа). Реэкспорт —
// чтобы прежние импортёры (rewrite.ts, тесты) брали их отсюда, где живут типы
// вызовов ModelCall/MeaningCheckCall, а не переезжали.
export type { ModelOutput, MeaningCheckOutput }

// Вызов модели: Brief в терминах домена → распарсенный вывод, либо null, если
// модель вернула не-JSON. Форма сообщений чат-API за этот seam не выходит — её
// строит adapter из Brief (issue #21). Сетевые ошибки и таймаут бросаются (их
// показывают читателю как внятную ошибку, а не молча ретраят).
export type ModelCall = (brief: RewriteBrief) => Promise<ModelOutput | null>

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

// Транспорт как зависимость: функция запроса (в проде — сеть, в тестах —
// подставная) и пауза backoff (в проде — таймер, в тестах — мгновенная, чтобы
// повтор по 429 проверялся без ожидания). Два adapter оправдывают seam — тот, что
// ходит в сеть, и тот, что её изображает (issue #22).
export type Transport = {
  request: (url: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
}

// Настоящий сетевой adapter: fetch с таймаутом плюс реальная пауза backoff.
const httpTransport: Transport = {
  request: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

// Единственный HTTP-adapter обоих вызовов: POST на /chat/completions с повтором
// по 429/5xx и разбор ответа до content первого choice. Функцию запроса и паузу
// берёт из transport — за этим seam и тестируются повтор, backoff и таймаут.
// label подставляется в текст ошибок («модель недоступна», «смысловая сверка
// ответила 500») — оба существительных женского рода, поэтому формулировки
// согласуются. Недоступность, таймаут и не-2xx бросают Error; иначе возвращается
// сырой content для разбора вызывающим (parse.ts).
export async function fetchChatContent(
  messages: ChatMessage[],
  label: string,
  transport: Transport = httpTransport,
): Promise<string> {
  const { baseUrl, model, apiKey } = llmConfig()

  let res: Response | null = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      res = await transport.request(`${baseUrl}/chat/completions`, {
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
    await transport.sleep(pause)
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

// Из единственного adapter вызов лепится тремя данными: чем строить сообщения из
// Brief, чем разбирать content и как назвать себя в ошибке. Прежние два wrapper
// (callModelOverHttp/callMeaningCheckOverHttp) различались ровно этим и изображали
// «два adapter» там, где adapter один — теперь оба это привязки одного httpCall
// (issue #22). Форма сообщений чат-API строится здесь, за seam, и уносится в сеть.
function httpCall<B, O>(
  build: (brief: B) => ChatMessage[],
  parse: (content: string) => O | null,
  label: string,
): (brief: B) => Promise<O | null> {
  return (brief) => fetchChatContent(build(brief), label).then(parse)
}

// Реальный вызов модели по HTTP. Недоступность, таймаут и не-2xx бросают Error с
// внятным текстом; не-JSON content возвращает null (неудачная попытка).
export const callModelOverHttp: ModelCall = httpCall(buildMessages, parseModelContent, 'модель')

// Реальный вызов судьи Meaning Check по HTTP. Тот же adapter; не-JSON content
// возвращает null. Бросок наверху ловится generateRewrite и превращается в
// честную пометку «сверка не проведена» — запрос при этом не падает целиком.
export const callMeaningCheckOverHttp: MeaningCheckCall = httpCall(
  buildMeaningCheckMessages,
  parseMeaningCheckContent,
  'смысловая сверка',
)
