import { z } from 'zod'

// Разбор ответа модели — третья забота рядом с авторством промпта (prompt.ts) и
// транспортом (llm.ts): здесь content из ответа модели превращается в вывод
// домена, и здесь же снимается markdown (issue #22, PRD #18). Отладка «модель
// вернула мусор» начинается тут, а не в коде про retry: разбор живёт отдельно от
// сети и покрыт своими тестами.

// Модель обязана вернуть JSON ровно такой формы. Невалидный JSON или нехватка
// полей — это просто ещё одна неудачная попытка (см. parseModelContent).
const modelOutputSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})
export type ModelOutput = z.infer<typeof modelOutputSchema>

// Вердикт Meaning Check — смысловой сверки (docs/adr/0005, docs/adr/0007).
// consistent:true — исход события (Outcome) сохранён; false — найдено искажение
// (Distortion), и distortion называет его.
const meaningCheckOutputSchema = z.object({
  consistent: z.boolean(),
  distortion: z.string(),
})
export type MeaningCheckOutput = z.infer<typeof meaningCheckOutputSchema>

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
