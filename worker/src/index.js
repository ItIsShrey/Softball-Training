// Checks a "Log in with Telegram" result and swaps it for a Firebase custom token.
// The bot token never leaves this Worker, so nobody can forge a Telegram login.
// Telegram's check: https://core.telegram.org/widgets/login#checking-authorization

const MAX_AGE_SECONDS = 24 * 60 * 60;
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/auth/telegram') {
      return json({ error: 'not_found' }, 404, cors);
    }
    let data;
    try { data = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }

    if (!(await telegramLoginIsValid(data, env.BOT_TOKEN))) {
      return json({ error: 'invalid_login' }, 401, cors);
    }
    const uid = 'tg:' + data.id;
    const token = await firebaseCustomToken(env, uid, {
      tg: String(data.id),
      tgUsername: data.username || '',
    });
    return json({ token, uid, name: [data.first_name, data.last_name].filter(Boolean).join(' ') }, 200, cors);
  },
};

async function telegramLoginIsValid(data, botToken) {
  if (!data || !data.hash || !data.id || !data.auth_date) return false;
  if (Date.now() / 1000 - Number(data.auth_date) > MAX_AGE_SECONDS) return false;
  const checkString = Object.keys(data)
    .filter(k => k !== 'hash' && data[k] !== undefined && data[k] !== null)
    .sort()
    .map(k => `${k}=${data[k]}`)
    .join('\n');
  const secret = await crypto.subtle.digest('SHA-256', enc.encode(botToken));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(checkString));
  return timingSafeEqual(hex(sig), String(data.hash).toLowerCase());
}

// https://firebase.google.com/docs/auth/admin/create-custom-tokens#create_custom_tokens_using_a_third-party_jwt_library
async function firebaseCustomToken(env, uid, claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
    claims,
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBytes(env.FIREBASE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
  return unsigned + '.' + b64url(new Uint8Array(sig));
}

function pemToBytes(pem) {
  const body = String(pem).replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), c => c.charCodeAt(0));
}
function b64url(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
