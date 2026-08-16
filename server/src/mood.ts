import { z } from 'zod'

// Набор Mood конечен и задан кодом — пользователь не может придумать свой
// (см. CONTEXT.md). Порядок здесь — порядок, в котором Mood показываются фронту.
const MOOD_IDS = ['neutral', 'joyful', 'sad', 'ironic', 'dramatic'] as const

export const moodSchema = z.enum(MOOD_IDS)
export type Mood = z.infer<typeof moodSchema>

// Человеческие названия Mood: их отдаёт GET /api/moods, чтобы фронт не дублировал
// список у себя.
export const MOOD_LABELS: Record<Mood, string> = {
  neutral: 'Нейтрально',
  joyful: 'Радостно',
  sad: 'Грустно',
  ironic: 'Иронично',
  dramatic: 'Драматично',
}

// Эмоциональный регистр для промпта — задаёт тон, но не трогает факты.
export const MOOD_REGISTER: Record<Mood, string> = {
  neutral: 'Нейтрально и сдержанно, сухая подача фактов без эмоциональной окраски.',
  joyful: 'Радостно и оптимистично, с лёгкостью и воодушевлением.',
  sad: 'Грустно и меланхолично, с нотой печали.',
  ironic: 'Иронично, с сарказмом и лёгкой насмешкой.',
  dramatic: 'Драматично и напряжённо, с ощущением накала и высоких ставок.',
}

// Список Mood с человеческими названиями для GET /api/moods.
export function moodsPayload(): { moods: Array<{ id: Mood; label: string }> } {
  return {
    moods: MOOD_IDS.map((id) => ({ id, label: MOOD_LABELS[id] })),
  }
}
