// Firebase setup plus a small wrapper so page code reads like the original planner:
// db.collection(path).onSnapshot(...), db.doc(path).set(...), db.collection(path).doc() for a new id.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut, signInWithCustomToken } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, setDoc, deleteDoc, updateDoc, getDoc, query, where, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, telegram, owner } from './firebase-config.js';
export { telegram, owner };
export const telegramEnabled = !!(telegram && telegram.bot && telegram.authUrl);

export const configured = !String(firebaseConfig.apiKey).includes('REPLACE_ME');
const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
// Keeps a copy of the data on the device, so reopening the page loads fast and re-downloads only what changed.
const fs = app ? initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }) : null;

export function currentUser() {
  return new Promise(resolve => { const stop = onAuthStateChanged(auth, u => { stop(); resolve(u); }); });
}
export const logOut = () => signOut(auth);

// Sends the Telegram widget's result to the Worker, which checks it and returns a Firebase token.
export async function signInTelegram(tgUser) {
  const res = await fetch(telegram.authUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tgUser) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'telegram_login_failed');
  }
  const { token, name } = await res.json();
  await signInWithCustomToken(auth, token);
  try { localStorage.setItem('tgProfile', JSON.stringify({ name: name || '', username: tgUser.username || '', photo: tgUser.photo_url || '' })); } catch (e) {}
  return auth.currentUser;
}
// Telegram name and @username of the person logged in, for link requests. The username comes from the signed token.
export async function telegramProfile() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('tgProfile') || '{}'); } catch (e) {}
  const claims = auth.currentUser ? (await auth.currentUser.getIdTokenResult()).claims : {};
  return { name: saved.name || '', username: claims.tgUsername || '', photo: saved.photo || '' };
}
// Tells the excos' Telegram chat about a last-minute reply change. The Worker reads the reply itself and
// only posts real changes made in the 6 hours before a training, and only for the member who made them.
export async function notifyExcos(date, memberId) {
  if (!telegram.authUrl) return;
  try {
    const idToken = await auth.currentUser.getIdToken();
    await fetch(telegram.authUrl.replace(/\/auth\/telegram$/, '/notify'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, date, memberId }) });
  } catch (e) {}
}
// Asks the bot to post a published training to the club's Telegram group. Only excos can.
export async function announceTraining(date) {
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(telegram.authUrl.replace(/\/auth\/telegram$/, '/announce'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, date }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'announce_failed');
  return body;
}
// Draws Telegram's official login button into el; onUser gets the signed login data.
export function mountTelegramButton(el, onUser) {
  if (!el || el.dataset.mounted) return;
  el.dataset.mounted = '1';
  window.onTelegramAuth = onUser;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://telegram.org/js/telegram-widget.js?22';
  s.setAttribute('data-telegram-login', telegram.bot);
  s.setAttribute('data-size', 'large');
  s.setAttribute('data-radius', '8');
  s.setAttribute('data-request-access', 'write');
  s.setAttribute('data-onauth', 'onTelegramAuth(user)');
  el.appendChild(s);
}

const wrapSnap = s => ({ id: s.id, exists: s.exists(), data: () => s.data() });
const wrapQuery = s => ({ docs: s.docs.map(d => ({ id: d.id, data: () => d.data() })) });

function ref(path) {
  const r = () => doc(fs, path);
  return {
    id: path.split('/').pop(), path,
    get: () => getDoc(r()).then(wrapSnap),
    set: data => setDoc(r(), data),
    update: data => updateDoc(r(), data),
    delete: () => deleteDoc(r()),
    onSnapshot: (next, err) => onSnapshot(r(), s => next(wrapSnap(s)), err),
  };
}
function col(path, filters = []) {
  const q = () => filters.length ? query(collection(fs, path), ...filters.map(f => where(...f))) : collection(fs, path);
  return {
    path,
    doc: id => ref(path + '/' + (id || doc(collection(fs, path)).id)),
    where: (field, op, value) => col(path, [...filters, [field, op, value]]),
    onSnapshot: (next, err) => onSnapshot(q(), s => next(wrapQuery(s)), err),
  };
}
// Several writes that land together or not at all: [['set', path, data], ['delete', path]].
async function batch(ops) {
  const b = writeBatch(fs);
  for (const [op, path, data] of ops) op === 'delete' ? b.delete(doc(fs, path)) : b.set(doc(fs, path), data);
  await b.commit();
}
export const db = { collection: col, doc: ref, batch };
