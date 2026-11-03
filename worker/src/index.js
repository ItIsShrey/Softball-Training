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
      return notifyExcos(request, env, cors).catch(e => { console.log('notify error', String(e && e.message || e)); return new Response(null, { status: 204, headers: cors }); });
    }
    if (request.method === 'POST' && url.pathname === '/announce') {
      return announceTraining(request, env, cors).catch(e => { console.log('announce error', String(e && e.message || e)); return json({ error: 'failed' }, 500, cors); });
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
// within 6 hours of a published training, and only once per change.
const STATUS = { yes: 'Coming', late: 'Coming late', early: 'Leaving early', no: "Can't make it" };
async function notifyExcos(request, env, cors) {
  const done = why => { if (why) console.log('notify skipped:', why); return new Response(null, { status: 204, headers: cors }); };
  if (!env.EXCO_CHAT_ID || !env.FIREBASE_PROJECT_ID) return done('EXCO_CHAT_ID or FIREBASE_PROJECT_ID not set');
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
  if (!reply || !session || !person || val(session, 'published') !== true) return done(`missing data: reply=${!!reply} session=${!!session} person=${!!person} published=${session && val(session, 'published')}`);
  const now = Date.now();
  const changedAt = Date.parse(reply.updateTime);
  const startsAt = Date.parse(`${date}T${val(session, 'start') || '15:30'}:00+08:00`);
  if (!(now - changedAt < 5 * 60 * 1000)) return done('reply not changed in the last 5 minutes');
  if (!(startsAt - changedAt < 6 * 3600 * 1000 && changedAt < startsAt + 3 * 3600 * 1000)) return done('not within 6 hours of the training');
  const status = val(reply, 'status') || (val(reply, 'going') ? 'yes' : 'no');
  const prev = val(reply, 'prev') || '';
  if (status === 'yes' && !prev) return done('first yes, nothing to report');

  // Once per saved change, even if the page calls twice.
  const seen = new Request(`https://dedup.local/${date}_${memberId}/${encodeURIComponent(reply.updateTime)}`);
  if (await caches.default.match(seen)) return done('already sent');
  await caches.default.put(seen, new Response('1', { headers: { 'Cache-Control': 'max-age=86400' } }));

  const time = val(reply, 'time');
  const reason = val(reply, 'reason');
  const day = new Date(`${date}T12:00:00+08:00`).toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' });
  const text = [
    `${val(person, 'name')}: ${STATUS[status] || status} on ${day}` + (prev && prev !== status ? ` (was ${(STATUS[prev] || prev).toLowerCase()})` : ''),
    time ? `${status === 'late' ? 'Arriving' : 'Leaving'} at ${time}.` : '',
    reason ? `Reason: ${reason}` : '',
  ].filter(Boolean).join('\n');
  const sent = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.EXCO_CHAT_ID, text, disable_web_page_preview: true }),
  });
  console.log('notify telegram', sent.status, sent.ok ? '' : await sent.text());
  return done();
}

// An exco asks the bot to post a published training to the club group, with a button to reply in the app.
const VENUES = { MPSH: 'MPSH (hall)', Kallang: 'Kallang field', Jurong: 'Jurong field' };
const HYPE = [
  'Bring the energy, bring your glove! 💪',
  'Time to put in the reps! 🔥',
  'Let\'s get better together! 🙌',
  'Come swing, catch and have fun! ⚡',
  'Every rep counts. See you there! 💥',
];
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clock = t => { const [h, m] = String(t || '').split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`; };
async function announceTraining(request, env, cors) {
  const chat = env.ANNOUNCE_CHAT_ID || env.GROUP_CHAT_ID;
  if (!chat || !env.FIREBASE_PROJECT_ID) return json({ error: 'no_chat' }, 409, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
  const { idToken, date } = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return json({ error: 'bad_request' }, 400, cors);
  const uid = await verifyIdToken(env, String(idToken || ''));
  if (!uid) return json({ error: 'not_signed_in' }, 401, cors);
  const token = await googleAccessToken(env);
  const always = String(env.ALWAYS_ALLOW || '').split(',').map(s => 'tg:' + s.trim());
  if (!always.includes(uid) && !(await firestoreGet(env, token, `admins/${uid}`))) return json({ error: 'not_exco' }, 403, cors);
  const session = await firestoreGet(env, token, `sessions/${date}`);
  if (!session || val(session, 'published') !== true) return json({ error: 'not_published' }, 409, cors);

  const day = new Date(`${date}T12:00:00+08:00`).toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Singapore' });
  const venue = VENUES[val(session, 'venue')] || val(session, 'venue') || '';
  const hype = HYPE[Math.floor(Math.random() * HYPE.length)];
  const text = [
    '🥎 <b>TRAINING TIME!</b> 🥎',
    '',
    `📅 <b>${esc(day)}</b>`,
    `⏰ ${clock(val(session, 'start') || '15:30')} – ${clock(val(session, 'end') || '18:00')}`,
    venue ? `📍 ${esc(venue)}` : '',
    '',
    hype,
    '👇 Let us know if you\'re coming!',
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '🙋 I\'m in / can\'t make it', url: env.ALLOWED_ORIGIN }]] } }),
  });
  if (!res.ok) { console.log('announce telegram', res.status, await res.text()); return json({ error: 'telegram_failed' }, 502, cors); }
  const announcedAt = new Date().toISOString();
  await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/sessions/${date}?updateMask.fieldPaths=announcedAt`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { announcedAt: { stringValue: announcedAt } } }),
  });
  return json({ ok: true, announcedAt }, 200, cors);
}

// Checks a Firebase ID token (from the signed-in page) and returns its uid, or '' if it isn't valid.
// https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
let jwks = null;
async function verifyIdToken(env, idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) return '';
  let header, payload;
  try { header = JSON.parse(b64urlText(parts[0])); payload = JSON.parse(b64urlText(parts[1])); } catch { return ''; }
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || payload.aud !== env.FIREBASE_PROJECT_ID
    || payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`
    || !(payload.exp > now) || !(payload.iat <= now + 300) || !payload.sub) return '';
  if (!jwks || jwks.exp < Date.now()) {
    const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    jwks = { keys: (await res.json()).keys || [], exp: Date.now() + 3600 * 1000 };
  }
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) return '';
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  return ok ? String(payload.sub) : '';
}
function b64urlBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }

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
  if (!res.ok) throw new Error('google_token_failed ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const { access_token, expires_in } = await res.json();
  cachedToken = { value: access_token, exp: now + (expires_in || 3600) };
  return access_token;
}
async function firestoreGet(env, token, path) {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) console.log('firestore read failed', path.split('/')[0], res.status, (await res.text()).slice(0, 200));
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
