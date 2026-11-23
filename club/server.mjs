import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { authorizationUrl, digest, providerProfile, randomToken } from './auth.mjs';
import { escape, login, page, profilePage, recommendationsPage, trainingPage } from './views.mjs';
import { mondayOf, todayInMoscow, workoutSummary } from './weeks.mjs';

const stylesheet = await readFile(new URL('./club.css', import.meta.url));
const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const providers = new Set(['vk', 'yandex']);
const loginAge = 10 * 60;
const sessionAge = 14 * 86400;
const now = () => Math.floor(Date.now() / 1000);
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[a-f0-9-]{36}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function redirect(response, location, status = 303) {
  response.writeHead(status, { Location: String(location) }).end();
}

function send(response, status, body, type = 'text/html; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type }).end(body);
}

function cookieName(config, key) {
  return (config.secure ? '__Host-' : '') + 'club-' + key;
}

function readCookie(request, config, key) {
  const name = cookieName(config, key) + '=';
  const pair = (request.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(name));
  const value = pair?.slice(name.length);
  return tokenPattern.test(value || '') ? value : null;
}

function setCookie(response, config, key, value, age) {
  const cookie = cookieName(config, key) + '=' + value +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age + (config.secure ? '; Secure' : '');
  response.setHeader('Set-Cookie', [...(response.getHeader('Set-Cookie') || []), cookie]);
}

async function readForm(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    throw new RequestError(415, 'Открой форму и попробуй ещё раз.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16000) throw new RequestError(413, 'Форма слишком длинная.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function field(fields, key, length, required = false) {
  const value = (fields.get(key) || '').trim();
  if ((required && !value) || value.length > length || value.includes('\0')) {
    throw new RequestError(400, 'Проверь, что обязательные поля заполнены, а текст помещается в форму.');
  }
  return value;
}

function recommendation(fields, kind) {
  const title = field(fields, 'title', 120, true);
  const creator = field(fields, 'creator', 120, true);
  const note = field(fields, 'note', 600);
  const rawLink = kind === 'music' ? field(fields, 'link', 500) : '';
  let link = '';
  if (rawLink) {
    const url = URL.parse(rawLink);
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new RequestError(400, 'Укажи ссылку, которая начинается с https:// или http://.');
    }
    link = url.href;
  }
  return [title, creator, note, link];
}

async function getSession(store, token, config) {
  if (!token) return null;
  const row = await store.one(`
    SELECT m.id, m.name, m.provider
    FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token_hash = $1 AND s.expires > $2
  `, digest(token), now());
  return row ? { ...row, csrf: digest('form:' + token), owner: row.id === config.owner } : null;
}

async function authRoute(request, response, url, store, config, provider, isCallback) {
  if (!config[provider]) return send(response, 503, login(config, true));
  const key = 'oauth-' + provider;

  if (!isCallback) {
    const state = randomToken();
    const browser = randomToken();
    const verifier = randomToken();
    await store.run('DELETE FROM oauth_attempts WHERE expires < $1', now());
    await store.run(`
      INSERT INTO oauth_attempts (state, browser_hash, provider, verifier, expires)
      VALUES ($1, $2, $3, $4, $5)
    `, state, digest(browser), provider, verifier, now() + loginAge);
    setCookie(response, config, key, browser, loginAge);
    return redirect(response, authorizationUrl(config.origin, provider, config[provider], state, verifier), 302);
  }

  const browser = readCookie(request, config, key);
  const state = url.searchParams.get('state') || '';
  if (!browser || !tokenPattern.test(state)) return redirect(response, '/?login=error');
  const attempt = await store.one(`
    DELETE FROM oauth_attempts
    WHERE state = $1 AND browser_hash = $2 AND provider = $3 AND expires > $4
    RETURNING state, verifier
  `, state, digest(browser), provider, now());
  if (!attempt) return redirect(response, '/?login=error');
  setCookie(response, config, key, '', 0);
  if (url.searchParams.has('error')) return redirect(response, '/?login=error');

  let profile;
  try {
    profile = await providerProfile(config, provider, url.searchParams, attempt);
  } catch {
    console.warn('OAuth exchange failed for ' + provider);
    return redirect(response, '/?login=error');
  }
  await store.run(`
    INSERT INTO members (id, provider, subject, name) VALUES ($1, $2, $3, $4)
    ON CONFLICT (provider, subject) DO NOTHING
  `, randomUUID(), provider, profile.subject, profile.name);
  const member = await store.one('SELECT id FROM members WHERE provider = $1 AND subject = $2', provider, profile.subject);
  const token = randomToken();
  await store.run('DELETE FROM sessions WHERE expires < $1 OR token_hash = $2',
    now(), digest(readCookie(request, config, 'session') || ''));
  await store.run('INSERT INTO sessions (token_hash, member_id, expires) VALUES ($1, $2, $3)',
    digest(token), member.id, now() + sessionAge);
  setCookie(response, config, 'session', token, sessionAge);
  return redirect(response, '/training');
}

async function trainingData(store, session) {
  const today = todayInMoscow();
  const monday = mondayOf(today);
  const members = await store.all('SELECT id, name FROM members ORDER BY name, id');
  const workouts = await store.all('SELECT member_id, day FROM workouts WHERE day <= $1', today);
  const daysByMember = new Map(members.map(member => [member.id, []]));
  for (const workout of workouts) daysByMember.get(workout.member_id)?.push(workout.day);
  return {
    today,
    monday,
    days: daysByMember.get(session.id) || [],
    board: members.map(member => ({ ...member, ...workoutSummary(daysByMember.get(member.id), monday) })),
  };
}

async function handlePost(request, response, url, store, config, session, token) {
  if (request.headers.origin && request.headers.origin !== config.origin) {
    throw new RequestError(403, 'Открой форму на странице клуба.');
  }
  const fields = await readForm(request);
  if (fields.get('csrf') !== session.csrf) throw new RequestError(403, 'Открой форму и попробуй ещё раз.');
  const path = url.pathname;

  if (path === '/logout') {
    await store.run('DELETE FROM sessions WHERE token_hash = $1', digest(token));
    setCookie(response, config, 'session', '', 0);
    return redirect(response, '/');
  }
  if (path === '/profile') {
    await store.run('UPDATE members SET name = $1 WHERE id = $2', field(fields, 'name', 60, true), session.id);
    return redirect(response, '/profile');
  }
  if (path === '/training') {
    const day = fields.get('day') || '';
    const action = fields.get('action');
    const today = todayInMoscow();
    if (!datePattern.test(day) || day < mondayOf(today) || day > today ||
        new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day ||
        !['add', 'remove'].includes(action)) {
      throw new RequestError(400, 'Выбери прошедший или текущий день этой недели.');
    }
    if (action === 'add') {
      await store.run('INSERT INTO workouts (member_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', session.id, day);
    } else {
      await store.run('DELETE FROM workouts WHERE member_id = $1 AND day = $2', session.id, day);
    }
    return redirect(response, '/training');
  }

  const [, kind, id, action, extra] = path.split('/');
  if (extra !== undefined || !['books', 'music'].includes(kind)) {
    throw new RequestError(404, 'Страница не найдена.');
  }
  if (id === undefined) {
    await store.run(`
      INSERT INTO recommendations (id, member_id, kind, title, creator, note, link, created)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, randomUUID(), session.id, kind, ...recommendation(fields, kind), Date.now());
  } else {
    if (!idPattern.test(id) || !['edit', 'delete', 'reply'].includes(action)) {
      throw new RequestError(404, 'Рекомендация не найдена.');
    }
    const item = await store.one('SELECT member_id FROM recommendations WHERE id = $1 AND kind = $2', id, kind);
    if (!item) throw new RequestError(404, 'Рекомендация не найдена.');
    if (action === 'reply') {
      if (!session.owner) throw new RequestError(403, 'Ответить может Анастасия.');
      const value = fields.get('reaction') ?? '';
      if (!['', 'later', 'done'].includes(value)) throw new RequestError(400, 'Выбери отметку из списка.');
      await store.run('UPDATE recommendations SET reaction = $1, reply = $2 WHERE id = $3',
        value, field(fields, 'reply', 600), id);
    } else {
      if (item.member_id !== session.id) throw new RequestError(403, 'Менять запись может её автор.');
      if (action === 'edit') {
        await store.run(`
          UPDATE recommendations SET title = $1, creator = $2, note = $3, link = $4 WHERE id = $5
        `, ...recommendation(fields, kind), id);
      } else {
        await store.run('DELETE FROM recommendations WHERE id = $1', id);
      }
    }
  }
  return redirect(response, '/' + kind);
}

export function clubHandler(store, config) {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy',
      "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    let session;
    try {
      const url = new URL(request.url, config.origin);
      if (url.origin !== config.origin || !['GET', 'POST'].includes(request.method)) {
        throw new RequestError(405, 'Этот запрос не поддерживается.');
      }
      const path = url.pathname;
      if (request.method === 'GET') {
        if (path === '/health') {
          await store.one('SELECT 1');
          return send(response, 200, 'ok', 'text/plain; charset=utf-8');
        }
        if (path === '/club.css') return send(response, 200, stylesheet, 'text/css; charset=utf-8');
        const match = /^\/auth\/([^/]+)(\/callback)?$/.exec(path);
        if (match && providers.has(match[1])) return await authRoute(request, response, url, store, config, match[1], Boolean(match[2]));
      }

      const token = readCookie(request, config, 'session');
      session = await getSession(store, token, config);
      if (!session) {
        if (request.method === 'POST') throw new RequestError(401, 'Войди в клуб, чтобы продолжить.');
        if (path !== '/') return redirect(response, '/');
        return send(response, 200, login(config, url.searchParams.get('login') === 'error'));
      }
      if (request.method === 'POST') return await handlePost(request, response, url, store, config, session, token);
      if (path === '/') return redirect(response, '/training');
      if (path === '/profile') return send(response, 200, profilePage(session));
      if (path === '/training') return send(response, 200, trainingPage(session, await trainingData(store, session)));
      const kind = path.slice(1);
      if (['books', 'music'].includes(kind)) {
        const requestedPage = Number(url.searchParams.get('page'));
        const number = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 100000) : 1;
        const items = await store.all(`
          SELECT r.*, m.name FROM recommendations r JOIN members m ON m.id = r.member_id
          WHERE r.kind = $1 ORDER BY r.created DESC, r.id LIMIT 21 OFFSET $2
        `, kind, (number - 1) * 20);
        return send(response, 200, recommendationsPage(session, kind, items.slice(0, 20), number, items.length > 20));
      }
      throw new RequestError(404, 'Страница не найдена.');
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      const message = status < 500 ? error.message : 'Произошла ошибка. Попробуй чуть позже.';
      if (status === 500) console.error('Club request failed:', error.code || error.name);
      if (!response.headersSent) {
        send(response, status, page('Ошибка', `<p class="notice" role="alert">${escape(message)}</p><a href="/">Главная клуба</a>`, session));
      }
    }
  };
}

export async function openStore(databaseUrl, localDb) {
  if (databaseUrl) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10000 });
    pool.on('error', error => console.error('Database connection interrupted:', error.code || error.name));
    await pool.query(schema);
    return {
      one: async (sql, ...values) => (await pool.query(sql, values)).rows[0],
      all: async (sql, ...values) => (await pool.query(sql, values)).rows,
      run: async (sql, ...values) => pool.query(sql, values),
    };
  }
  if (!localDb) throw new Error('Set DATABASE_URL or LOCAL_DB');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(localDb);
  db.exec(schema);
  const execute = (method, sql, values) => {
    const statement = db.prepare(sql);
    if (!values.length) return statement[method]();
    const params = Object.fromEntries(values.map((value, index) => ['$' + (index + 1), value]));
    return statement[method](params);
  };
  return {
    one: (sql, ...values) => execute('get', sql, values),
    all: (sql, ...values) => execute('all', sql, values),
    run: (sql, ...values) => execute('run', sql, values),
  };
}

async function main() {
  const env = process.env;
  const port = Number(env.PORT || 8001);
  const address = new URL(env.APP_ORIGIN || env.RENDER_EXTERNAL_URL || 'http://localhost:' + port);
  if (env.DATABASE_URL && address.protocol !== 'https:') throw new Error('Set the public HTTPS APP_ORIGIN');
  const config = {
    origin: address.origin,
    secure: address.protocol === 'https:',
    vk: env.VK_CLIENT_ID,
    yandex: env.YANDEX_CLIENT_ID,
    yandexSecret: env.YANDEX_CLIENT_SECRET,
    owner: env.OWNER_MEMBER_ID,
  };
  const store = await openStore(env.DATABASE_URL, env.LOCAL_DB);
  const server = createServer(clubHandler(store, config));
  server.listen(port, env.DATABASE_URL ? '0.0.0.0' : '127.0.0.1', () => {
    console.log('Club listening:', config.origin);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Club startup failed:', error.code || error.message);
    process.exit(1);
  });
}
