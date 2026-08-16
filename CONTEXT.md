# Mood News

Читалка реальных новостей, где один и тот же материал можно прочитать в разных
эмоциональных регистрах. Меняется тон — факты остаются неизменными.

## Language

### Материал

**Article**:
Одна реальная новость, забранная из внешнего источника. Неизменяема: то, что
пришло из источника, никогда не редактируется.
_Avoid_: News, Post, Item, Entry

**Source**:
Внешняя лента, из которой приходят Article. Каждая Article всегда знает свой
Source и ведёт на исходную публикацию.
_Avoid_: Feed, Provider, Publisher

**Snippet**:
Текст Article в том виде, в котором его отдал Source — заголовок и анонс.
Единственная версия «как было»; полный текст публикации мы не забираем.
_Avoid_: Original text, Body, Content, Excerpt

**Ingest**:
Забор свежих Article из Source и их сохранение. Повторный Ingest уже известной
публикации ничего не добавляет.
_Avoid_: Fetch, Sync, Crawl, Import

### Переписывание

**Mood**:
Эмоциональный регистр, в котором читается Article. Набор Mood конечен и задан
проектом, пользователь не может придумать свой.
_Avoid_: Tone, Style, Emotion, Filter

**Rewrite**:
Версия Article в конкретном Mood. Пара «Article + Mood» определяет ровно один
Rewrite: получив его однажды, мы переиспользуем его всегда.
_Avoid_: Variant, Version, Generation, Translation

### Сохранность фактов

**Anchor**:
Фрагмент Snippet, который обязан дословно пережить переписывание: число, дата,
сумма, имя собственное, цитата. Список Anchor извлекается из Snippet
механически, до всякого обращения к модели.
_Avoid_: Fact, Entity, Keyword, Token

**Fact Check**:
Сверка Rewrite со списком Anchor его Article. Результат — часть Rewrite и
показывается читателю, а не прячется в логи.
_Avoid_: Validation, Verification, Guardrail

**Missing Anchor**:
Anchor, не найденный в Rewrite. Наличие хотя бы одного означает, что Rewrite не
прошёл Fact Check — но не отменяет его: читатель видит и текст, и потерю.
_Avoid_: Violation, Error, Hallucination
