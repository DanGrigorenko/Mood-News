import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractArticleText } from '../src/article-text.ts'

// Образцы HTML — урезанные, но со структурой реальных страниц (Ingest 2026-08-16):
// Коммерсантъ — <p class="doc__text">, РИА — <div class="article__text">,
// Интерфакс — <p> внутри <article itemprop="articleBody">. Реклама, меню и
// «читайте также» вокруг текста извлекаться не должны.

const kommersant = `<!doctype html><html><body>
  <nav class="menu"><a href="/">Реклама и меню сюда не попадают</a></nav>
  <div class="doc__body">
    <p class="doc__text">Первый абзац настоящей статьи с числом 56 и именем Артамонов: подробное описание события, которого хватает, чтобы модели было что переписывать, а Fact Check находил опорные факты.</p>
    <p class="doc__text">Второй абзац: <a href="/doc/1">ссылка</a> внутри текста сохраняется как текст, а окружающие подробности остаются в Snippet целиком, без обрыва на первом предложении.</p>
    <p class="doc__text"><b>Третий абзац с выделением</b> завершает материал и уточняет обстоятельства произошедшего для читателя.</p>
  </div>
  <div class="ad">Реклама Wildberries</div>
  <aside class="doc_related">Читайте также: другая новость</aside>
</body></html>`

const ria = `<!doctype html><html><body>
  <div class="header__menu">Меню РИА</div>
  <div class="article__body">
    <div class="article__block" data-type="text"><div class="article__text"><strong>МОСКВА, 16 авг - РИА Новости.</strong> Первый абзац с <a href="/loc/">ссылкой</a> внутри и достаточным количеством подробностей, чтобы текст был полноценной новостью, а не обрывком анонса из ленты.</div></div>
    <div class="article__block" data-type="text"><div class="article__text">Второй абзац настоящего текста статьи уточняет обстоятельства и добавляет детали, которых в коротком RSS-анонсе не было.</div></div>
    <div class="article__block" data-type="banner"><div class="banner">Реклама сюда не идёт</div></div>
  </div>
  <div class="article__announce">Читайте также</div>
</body></html>`

const interfax = `<!doctype html><html><body>
  <header><nav>Навигация Интерфакса</nav></header>
  <article itemprop="articleBody">
    <h1 itemprop="headline">Заголовок в тело не идёт</h1>
    <p>Москва. 16 августа. INTERFAX.RU - Первый абзац статьи с фактом и подробным изложением события, достаточным для переписывания под настроение без выдумывания недостающего.</p>
    <p>"Прямая речь", - сказал он, добавив ещё несколько уточняющих деталей о произошедшем.</p>
    <p>Третий абзац с деталями завершает заметку и подводит итог случившемуся.</p>
    <div itemprop="author"><meta itemprop="name" content="Интерфакс" /></div>
  </article>
  <div class="ad">Реклама после статьи</div>
  <p>Абзац вне article — не берём.</p>
</body></html>`

test('Коммерсантъ: берёт абзацы doc__text, без рекламы и «читайте также»', () => {
  const text = extractArticleText(kommersant, 'Коммерсантъ')
  assert.ok(text)
  assert.match(text!, /Первый абзац настоящей статьи с числом 56/)
  assert.match(text!, /Второй абзац: ссылка внутри текста/)
  assert.match(text!, /Третий абзац с выделением/)
  assert.doesNotMatch(text!, /Реклама/)
  assert.doesNotMatch(text!, /Читайте также/)
  assert.doesNotMatch(text!, /меню/)
})

test('РИА Новости: берёт блоки article__text, без баннеров и меню', () => {
  const text = extractArticleText(ria, 'РИА Новости')
  assert.ok(text)
  assert.match(text!, /МОСКВА, 16 авг - РИА Новости\./)
  assert.match(text!, /Первый абзац с ссылкой внутри/)
  assert.match(text!, /Второй абзац настоящего текста статьи/)
  assert.doesNotMatch(text!, /Реклама/)
  assert.doesNotMatch(text!, /Меню/)
  assert.doesNotMatch(text!, /Читайте также/)
})

test('Интерфакс: берёт абзацы из article, без заголовка, меню и рекламы', () => {
  const text = extractArticleText(interfax, 'Интерфакс')
  assert.ok(text)
  assert.match(text!, /Первый абзац статьи с фактом/)
  assert.match(text!, /Прямая речь/)
  assert.match(text!, /Третий абзац с деталями/)
  assert.doesNotMatch(text!, /Заголовок в тело/)
  assert.doesNotMatch(text!, /Навигация/)
  assert.doesNotMatch(text!, /Реклама/)
  assert.doesNotMatch(text!, /вне article/)
})

test('извлечение сохраняет абзацы раздельно', () => {
  const text = extractArticleText(kommersant, 'Коммерсантъ')
  assert.equal(text!.split('\n\n').length, 3)
})

// Заглушка антибота (ТАСС/Lenta) или чужая разметка — нужного контейнера нет,
// извлекать нечего: возвращаем null, новость не сохранится.
test('страница без нужного контейнера даёт null', () => {
  const stub = `<html><body><div class="captcha">Проверка Servicepipe</div></body></html>`
  assert.equal(extractArticleText(stub, 'Коммерсантъ'), null)
  assert.equal(extractArticleText(stub, 'РИА Новости'), null)
  assert.equal(extractArticleText(stub, 'Интерфакс'), null)
})

// Контейнер есть, но текст подозрительно короткий (обрывок, пустой абзац) —
// это не полная статья, сохранять наполовину нельзя.
test('подозрительно короткий текст даёт null', () => {
  const short = `<html><body><p class="doc__text">Коротко.</p></body></html>`
  assert.equal(extractArticleText(short, 'Коммерсантъ'), null)
})

test('неизвестный источник даёт null, а не бросает', () => {
  assert.equal(extractArticleText(kommersant, 'Неизвестный'), null)
})
