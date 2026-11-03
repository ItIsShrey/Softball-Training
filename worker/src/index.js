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
    if (request.method === 'POST' && url.pathname === '/notify') {
      return notifyExcos(request, env, cors).catch(() => new Response(null, { status: 204, headers: cors }));
    }
    if (request.method !== 'POST' || url.pathname !== '/auth/telegram') {
      return json({ error: 'not_found' }, 404, cors);
    }
    let data;
    try { data = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }

    if (!(await telegramLoginIsValid(data, env.BOT_TOKEN))) {
      return json({ error: 'invalid_login' }, 401, cors);
    }
    if (!(await inClubGroup(env, data.id))) {
      return json({ error: 'not_in_group' }, 403, cors);
    }
    const uid = 'tg:' + data.id;
    const token = await firebaseCustomToken(env, uid, {
      tg: String(data.id),
      tgUsername: data.username || '',
    });
    return json({ token, uid, name: [data.first_name, data.last_name].filter(Boolean).join(' ') }, 200, cors);
  },
};

// A member changed their reply close to a training. Anyone can call this, so it trusts nothing in the
// request: it reads the reply from Firestore and only posts a real change saved in the last few minutes,
// within 24 hours of a published training, and only once per change.
const STATUS = { yes: 'Coming', late: 'Coming late', early: 'Leaving early', no: "Can't make it" };
async function notifyExcos(request, env, cors) {
  const done = () => new Response(null, { status: 204, headers: cors });
  if (!env.EXCO_CHAT_ID || !env.FIREBASE_PROJECT_ID) return done();
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
  const { date, memberId } = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(memberId))) {
    return json({ error: 'bad_request' }, 400, cors);
  }
  const token = await googleAccessToken(env);
  const [reply, session, person] = await Promise.all([
    firestoreGet(env, token, `rsvps/${date}_${memberId}`),
    firestoreGet(env, token, `sessions/${date}`),
    firestoreGet(env, token, `roster/${memberId}`),
  ]);
  if (!reply || !session || !person || val(session, 'published') !== true) return done();
  const now = Date.now();
  const changedAt = Date.parse(reply.updateTime);
  const startsAt = Date.parse(`${date}T${val(session, 'start') || '15:30'}:00+08:00`);
  if (!(now - changedAt < 5 * 60 * 1000)) return done();
  if (!(startsAt - changedAt < 24 * 3600 * 1000 && changedAt < startsAt + 3 * 3600 * 1000)) return done();
  const status = val(reply, 'status') || (val(reply, 'going') ? 'yes' : 'no');
  const prev = val(reply, 'prev') || '';
  if (status === 'yes' && !prev) return done();

  // Once per saved change, even if the page calls twice.
  const seen = new Request(`https://dedup.local/${date}_${memberId}/${encodeURIComponent(reply.updateTime)}`);
  if (await caches.default.match(seen)) return done();
  await caches.default.put(seen, new Response('1', { headers: { 'Cache-Control': 'max-age=86400' } }));

  const time = val(reply, 'time');
  const reason = val(reply, 'reason');
  const day = new Date(`${date}T12:00:00+08:00`).toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' });
  const text = [
    `${val(person, 'name')}: ${STATUS[status] || status} on ${day}` + (prev && prev !== status ? ` (was ${(STATUS[prev] || prev).toLowerCase()})` : ''),
    time ? `${status === 'late' ? 'Arriving' : 'Leaving'} at ${time}.` : '',
    reason ? `Reason: ${reason}` : '',
  ].filter(Boolean).join('\n');
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.EXCO_CHAT_ID, text, disable_web_page_preview: true }),
  });
  return done();
}

// The Worker reads Firestore as the Firebase service account (the same key it signs logins with).
let cachedToken = null;
async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.value;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  };
  const assertion = await signJwt(env, header, claim);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  if (!res.ok) throw new Error('google_token_failed');
  const { access_token, expires_in } = await res.json();
  cachedToken = { value: access_token, exp: now + (expires_in || 3600) };
  return access_token;
}
async function firestoreGet(env, token, path) {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok ? res.json() : null;
}
function val(doc, key) {
  const f = doc && doc.fields && doc.fields[key];
  if (!f) return undefined;
  return 'stringValue' in f ? f.stringValue : 'booleanValue' in f ? f.booleanValue : 'integerValue' in f ? Number(f.integerValue) : undefined;
}

// Only people in the club's Telegram group can log in. GROUP_CHAT_ID unset means anyone with Telegram can.
// The bot has to be in that group for Telegram to answer. ALWAYS_ALLOW lists Telegram IDs let in regardless (the owner).
async function inClubGroup(env, userId) {
  const group = String(env.GROUP_CHAT_ID || '').trim();
  if (!group) return true;
  const always = String(env.ALWAYS_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
  if (always.includes(String(userId))) return true;
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(group)}&user_id=${encodeURIComponent(userId)}`);
  if (!res.ok) return false;
  const body = await res.json().catch(() => null);
  const m = body && body.ok && body.result;
  if (!m) return false;
  return ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member === true);
}

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
  return signJwt(env, header, payload);
}
async function signJwt(env, header, payload) {
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
