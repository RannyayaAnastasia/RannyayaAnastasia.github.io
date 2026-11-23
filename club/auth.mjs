import { createHash, randomBytes } from 'node:crypto';

const vk = 'https://id.vk.ru';
const yandex = 'https://oauth.yandex.ru';

export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('base64url');
export const callback = (origin, provider) => origin + '/auth/' + provider + '/callback';

export function authorizationUrl(origin, provider, clientId, state, verifier) {
  const isVK = provider === 'vk';
  const url = new URL('/authorize', isVK ? vk : yandex);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback(origin, provider),
    response_type: 'code',
    state,
    code_challenge: digest(verifier),
    code_challenge_method: isVK ? 's256' : 'S256',
    ...(isVK ? { scope: '', prompt: 'login' } : { scope: 'login:info' }),
  });
  return url;
}

async function getJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok || !data || data.error) throw new Error('OAuth provider rejected the request');
  return data;
}

export async function providerProfile(config, provider, params, attempt) {
  const code = params.get('code');
  if (!code) throw new Error('Missing authorization code');
  const exchange = {
    grant_type: 'authorization_code',
    client_id: config[provider],
    code_verifier: attempt.verifier,
  };
  let profile;
  let subject;
  let name;

  if (provider === 'vk') {
    const device = params.get('device_id');
    if (!device) throw new Error('Missing VK device ID');
    const tokenUrl = new URL('/oauth2/auth', vk);
    tokenUrl.search = new URLSearchParams({
      ...exchange,
      redirect_uri: callback(config.origin, provider),
      state: attempt.state,
      device_id: device,
    });
    const token = await getJSON(tokenUrl, { method: 'POST', body: new URLSearchParams({ code }) });
    if (token.state !== attempt.state || !token.access_token) throw new Error('Invalid VK token response');
    const profileUrl = new URL('/oauth2/user_info', vk);
    profileUrl.searchParams.set('client_id', config.vk);
    profile = (await getJSON(profileUrl, {
      method: 'POST',
      body: new URLSearchParams({ access_token: token.access_token }),
    })).user;
    subject = profile?.user_id;
    name = profile?.first_name;
  } else {
    const token = await getJSON(yandex + '/token', {
      method: 'POST',
      body: new URLSearchParams({
        ...exchange,
        code,
        ...(config.yandexSecret ? { client_secret: config.yandexSecret } : {}),
      }),
    });
    if (!token.access_token) throw new Error('Invalid Yandex token response');
    profile = await getJSON('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: 'OAuth ' + token.access_token },
    });
    subject = profile.id;
    name = profile.first_name;
  }
  if (!/^\d+$/.test(String(subject))) throw new Error('Invalid OAuth subject');
  return { subject: String(subject), name: String(name || '').trim().slice(0, 60) || 'Участник клуба' };
}
