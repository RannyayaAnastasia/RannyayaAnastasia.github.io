import { shiftDay } from './weeks.mjs';

export const portfolio = 'https://rannyayaanastasia.github.io/';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const e = escape;
const tabs = { training: 'Тренировки', books: 'Книги', music: 'Музыка' };
const dateFormat = new Intl.DateTimeFormat('ru', {
  day: 'numeric', month: 'long', timeZone: 'UTC',
});
const dateLabel = day => dateFormat.format(new Date(day + 'T00:00:00Z'));

export function page(title, body, session, current) {
  return `<!doctype html>
<html lang="ru"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#191e1b">
  <meta name="robots" content="noindex">
  <title>${e(title)} · Клуб Анастасии</title>
  <link rel="stylesheet" href="/club.css">
</head><body>
  <a class="skip" href="#main">Перейти к содержанию</a>
  <header class="site-header">
    <div class="wrap top"><a href="/">Клуб Анастасии</a><a href="${portfolio}">Портфолио</a></div>
  </header>
  <main class="wrap" id="main">
    ${session ? `<div class="member-bar"><span>Привет, ${e(session.name)}!</span>
    <a href="/profile">Профиль</a>
    ${form('/logout', session, '<button class="subtle">Выйти</button>')}</div>
    <nav class="tabs" aria-label="Разделы клуба">
      ${Object.entries(tabs).map(([key, name]) => `<a href="/${key}"${current === key ? ' aria-current="page"' : ''}>${name}</a>`).join('')}
    </nav>` : ''}
    ${body}
  </main>
</body></html>`;
}

export function login(config, error) {
  const button = (provider, name) => config[provider]
    ? `<a class="button ${provider}" href="/auth/${provider}">Войти через ${name}</a>`
    : `<button class="${provider}" disabled>Войти через ${name}</button>`;
  return page('Вход', `<section class="welcome"><h1>Клуб Анастасии</h1>
    <p class="lead">Здесь можно порекомендовать мне книгу или музыку и вместе отмечать тренировки.</p>
    <p>Войди через ВК или Яндекс. Твоё имя в клубе, счётчик тренировок и рекомендации будут видны вошедшим участникам. Имя можно изменить в профиле.</p>
    ${error ? '<p class="notice" role="alert">Не удалось войти. Попробуй начать вход заново.</p>' : ''}
    <div class="actions">${button('vk', 'ВК')}${button('yandex', 'Яндекс')}</div>
    ${config.vk && config.yandex ? '' : '<p class="muted">Вход станет доступен после подключения сервиса.</p>'}
  </section>`);
}

export function form(action, session, fields, className = '') {
  return `<form method="post" action="${action}" class="${className}">
    <input type="hidden" name="csrf" value="${e(session.csrf)}">${fields}
  </form>`;
}

export function trainingPage(session, { today, monday, days, board }) {
  const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const activeCount = board.filter(member => member.count > 0).length;
  const calendar = dayNames.map((name, index) => {
    const day = shiftDay(monday, index);
    const marked = days.includes(day);
    const label = name + ', ' + dateLabel(day);
    const caption = `<span>${name}</span><strong>${Number(day.slice(-2))}</strong>`;
    if (day > today) return `<button disabled title="${label}">${caption}</button>`;
    return form('/training', session, `
      <input type="hidden" name="day" value="${day}">
      <button name="action" value="${marked ? 'remove' : 'add'}" aria-pressed="${marked}"
        aria-label="${marked ? 'Снять отметку: ' : 'Отметить тренировку: '}${label}">${caption}</button>`);
  }).join('');

  return page('Тренировки', `<h1>Тренировки</h1>
    <p class="lead">${dateLabel(monday)} — ${dateLabel(shiftDay(monday, 6))} · московское время</p>
    <section class="panel">
      <h2>Моя неделя</h2>
      <p>Нажми на день, чтобы отметить тренировку или снять отметку.</p>
      <div class="calendar">${calendar}</div>
    </section>
    <section class="panel">
      <h2>Общая доска</h2>
      <p>На этой неделе тренировались <strong>${activeCount} из ${board.length}</strong> участников.</p>
      <div class="table-scroll"><table><thead><tr><th scope="col">Участник</th><th scope="col">Тренировок за неделю</th><th scope="col">Серия, нед.</th></tr></thead>
      <tbody>${board.map(member => `<tr><th scope="row">${e(member.name)}${member.id === session.id ? ' <span class="muted">(ты)</span>' : ''}</th><td>${member.count}</td><td>${member.streak}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted footnote">Для серии достаточно одной тренировки в неделю. Текущая неделя может продлить серию до воскресенья включительно.</p>
    </section>`, session, 'training');
}

function recommendationFields(kind, item = {}) {
  const book = kind === 'books';
  return `<label>${book ? 'Название книги' : 'Трек или альбом'}<input name="title" maxlength="120" required value="${e(item.title)}"></label>
    <label>${book ? 'Автор' : 'Исполнитель'}<input name="creator" maxlength="120" required value="${e(item.creator)}"></label>
    ${book ? '' : `<label>Ссылка <span class="muted">(необязательно)</span><input name="link" type="url" maxlength="500" value="${e(item.link)}"></label>`}
    <label>Почему советуешь? <span class="muted">(необязательно)</span><textarea name="note" maxlength="600" rows="3">${e(item.note)}</textarea></label>`;
}

export function recommendationsPage(session, kind, items, number, hasMore) {
  const book = kind === 'books';
  const title = tabs[kind];
  const complete = book ? 'Прочитала' : 'Послушала';
  const reactions = { '': 'Без отметки', later: 'Хочу познакомиться', done: complete };
  const list = items.map(item => {
    const path = '/' + kind + '/' + item.id;
    return `<article class="panel recommendation">
      <h3>${e(item.title)}</h3><p class="byline">${e(item.creator)} · советует ${e(item.name)}</p>
      ${item.note ? `<p class="preserve">${e(item.note)}</p>` : ''}
      ${item.link ? `<a href="${e(item.link)}" rel="nofollow noreferrer">Открыть ссылку</a>` : ''}
      ${item.reaction || item.reply ? `<blockquote><strong>Анастасия${item.reaction ? ' · ' + reactions[item.reaction] : ''}</strong>
        ${item.reply ? `<div class="preserve">${e(item.reply)}</div>` : ''}</blockquote>` : ''}
      ${session.id === item.member_id ? `<details><summary>Изменить или удалить</summary>
        ${form(path + '/edit', session, recommendationFields(kind, item) + '<button>Сохранить</button>', 'fields')}
        ${form(path + '/delete', session, '<button class="subtle">Удалить рекомендацию</button>')}
        </details>` : ''}
      ${session.owner ? `<details><summary>Ответить</summary>${form(path + '/reply', session,
        `<label>Отметка<select name="reaction">${Object.entries(reactions).map(([key, label]) =>
          `<option value="${key}"${key === item.reaction ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Ответ<textarea name="reply" rows="2" maxlength="600">${e(item.reply)}</textarea></label>
        <button>Сохранить ответ</button>`, 'fields')}</details>` : ''}
    </article>`;
  }).join('');
  return page(title, `<h1>${title}</h1>
    <div class="columns">
      <section class="panel"><h2>${book ? 'Посоветовать книгу' : 'Посоветовать музыку'}</h2>
        ${form('/' + kind, session, recommendationFields(kind) + '<button>Добавить рекомендацию</button>', 'fields')}
      </section>
      <section><h2>Рекомендации клуба</h2>${list || '<p class="muted">Здесь появятся рекомендации участников.</p>'}
        <div class="pagination">${number > 1 ? `<a href="/${kind}?page=${number - 1}">Назад</a>` : ''}
        ${hasMore ? `<a href="/${kind}?page=${number + 1}">Дальше</a>` : ''}</div>
      </section>
    </div>`, session, kind);
}

export function profilePage(session) {
  return page('Профиль', `<h1>Профиль</h1><section class="panel profile">
    ${form('/profile', session, `<label>Имя в клубе<input name="name" maxlength="60" required value="${e(session.name)}"></label>
    <button>Сохранить имя</button>`, 'fields')}
    <p class="muted">Вход через ${session.provider === 'vk' ? 'ВК' : 'Яндекс'}. Идентификатор профиля <code>${e(session.id)}</code>.</p>
  </section>`, session);
}
