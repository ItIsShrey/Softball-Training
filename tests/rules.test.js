// Checks firestore.rules against the Firestore emulator. Run with `npm test` in this folder (needs Java).
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';

const OWNER = 'tg:834667219';
const EXCO = 'tg:100';
const MEMBER = 'tg:200';      // linked to member m1
const NEWBIE = 'tg:300';      // logged in, not linked yet
const DATE = '2030-01-08';    // a published training
const DRAFT = '2030-01-10';   // not published

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-softball',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'admins', OWNER), { name: 'Owner' });
    await setDoc(doc(db, 'admins', EXCO), { name: 'Exco' });
    for (const id of ['m1', 'm2', 'm3']) {
      await setDoc(doc(db, 'members', id), { name: id, level: 3 });
      await setDoc(doc(db, 'roster', id), { name: id });
    }
    await setDoc(doc(db, 'claims', MEMBER), { memberId: 'm1', via: 'username' });
    await setDoc(doc(db, 'tgIndex', 'newbie_user'), { memberId: 'm3' });
    await setDoc(doc(db, 'sessions', DATE), { published: true, start: '15:30' });
    await setDoc(doc(db, 'sessions', DRAFT), { published: false });
    await setDoc(doc(db, 'memberPins', 'm2'), { pin: '1234' });
  });
});

const as = (uid, claims = {}) => env.authenticatedContext(uid, claims).firestore();
const anon = () => env.authenticatedContext('anonUid123', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const reply = (over = {}) => ({ date: DATE, memberId: 'm1', going: true, status: 'yes', uid: MEMBER, at: '2030-01-07T10:00:00Z', ...over });

test('signed-out and guest logins see nothing', async () => {
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), 'roster')));
  await assertFails(getDocs(collection(anon(), 'roster')));
  await assertFails(getDoc(doc(anon(), 'sessions', DATE)));
});

test('a new Telegram login can read the roster but not trainings or replies', async () => {
  const db = as(NEWBIE);
  await assertSucceeds(getDocs(collection(db, 'roster')));
  await assertFails(getDoc(doc(db, 'sessions', DATE)));
  await assertFails(getDocs(collection(db, 'rsvps')));
  await assertFails(getDocs(collection(db, 'members')));
});

test('a linked member sees published trainings and replies, not drafts or coach data', async () => {
  const db = as(MEMBER);
  await assertSucceeds(getDoc(doc(db, 'sessions', DATE)));
  await assertFails(getDoc(doc(db, 'sessions', DRAFT)));
  await assertSucceeds(getDocs(collection(db, 'rsvps')));
  await assertFails(getDocs(collection(db, 'members')));
  await assertFails(getDocs(collection(db, 'drills')));
});

test('excos read everything they need without being linked', async () => {
  const db = as(EXCO);
  await assertSucceeds(getDocs(collection(db, 'members')));
  await assertSucceeds(getDoc(doc(db, 'sessions', DRAFT)));
  await assertSucceeds(getDocs(collection(db, 'rsvps')));
  await assertSucceeds(getDocs(collection(db, 'claims')));
});

test('the PIN route is gone', async () => {
  await assertFails(setDoc(doc(as(NEWBIE), 'claims', NEWBIE), { memberId: 'm2', pin: '1234' }));
  await assertFails(getDoc(doc(as(EXCO), 'memberPins', 'm2')));
});

test('a login links itself only through the @username an exco recorded', async () => {
  await assertSucceeds(setDoc(doc(as(NEWBIE, { tgUsername: 'Newbie_User' }), 'claims', NEWBIE), { memberId: 'm3', via: 'username' }));
  await assertFails(setDoc(doc(as(NEWBIE, { tgUsername: 'Newbie_User' }), 'claims', NEWBIE), { memberId: 'm2', via: 'username' }));
  await assertFails(setDoc(doc(as(NEWBIE, { tgUsername: 'someone_else' }), 'claims', NEWBIE), { memberId: 'm3', via: 'username' }));
  await assertFails(setDoc(doc(as(NEWBIE), 'claims', MEMBER), { memberId: 'm3', via: 'username' }));
});

test('link requests come only from Telegram logins, for themselves', async () => {
  const req = { memberId: 'm2', tgName: 'New Person', tgUsername: '', at: 'now' };
  await assertSucceeds(setDoc(doc(as(NEWBIE), 'linkRequests', NEWBIE), req));
  await assertFails(setDoc(doc(as(NEWBIE), 'linkRequests', 'tg:999'), req));
  await assertFails(setDoc(doc(anon(), 'linkRequests', 'anonUid123'), req));
});

test('excos approve link requests; members cannot', async () => {
  await assertSucceeds(setDoc(doc(as(EXCO), 'claims', NEWBIE), { memberId: 'm2', approvedBy: EXCO, at: 'now' }));
  await assertFails(setDoc(doc(as(MEMBER), 'claims', NEWBIE), { memberId: 'm2', approvedBy: MEMBER, at: 'now' }));
});

test('only the owner adds or removes excos', async () => {
  await assertFails(setDoc(doc(as(EXCO), 'admins', 'tg:555'), { name: 'x' }));
  await assertFails(deleteDoc(doc(as(EXCO), 'admins', OWNER)));
  await assertSucceeds(setDoc(doc(as(OWNER), 'admins', 'tg:555'), { name: 'x' }));
  await assertSucceeds(deleteDoc(doc(as(OWNER), 'admins', EXCO)));
  await assertFails(setDoc(doc(as(OWNER), 'admins', 'someone@example.com'), { name: 'x' }));
});

test('the owner is an exco even without an admins entry', async () => {
  await env.withSecurityRulesDisabled(ctx => deleteDoc(doc(ctx.firestore(), 'admins', OWNER)));
  await assertSucceeds(getDocs(collection(as(OWNER), 'members')));
});

test('members reply yes, no, late or early for themselves', async () => {
  const db = as(MEMBER);
  const ref = doc(db, 'rsvps', `${DATE}_m1`);
  await assertSucceeds(setDoc(ref, reply()));
  await assertSucceeds(setDoc(ref, reply({ status: 'late', time: '16:30', reason: 'class until 4', prev: 'yes' })));
  await assertSucceeds(setDoc(ref, reply({ status: 'early', time: '17:00', reason: 'work', prev: 'late' })));
  await assertFails(setDoc(ref, reply({ status: 'maybe' })));
  await assertFails(setDoc(ref, reply({ status: 'no', going: true })));
  await assertFails(setDoc(doc(db, 'rsvps', `${DATE}_m2`), reply({ memberId: 'm2' })));
  await assertFails(setDoc(doc(db, 'rsvps', `${DRAFT}_m1`), reply({ date: DRAFT })));
});

test('late and early need a reason', async () => {
  const ref = doc(as(MEMBER), 'rsvps', `${DATE}_m1`);
  await assertFails(setDoc(ref, reply({ status: 'late', time: '16:30' })));
  await assertFails(setDoc(ref, reply({ status: 'early', reason: '' })));
  await assertFails(setDoc(ref, reply({ status: 'late', reason: 'x'.repeat(201) })));
});

test('changing a yes to a no needs a reason; a first no does not', async () => {
  const ref = doc(as(MEMBER), 'rsvps', `${DATE}_m1`);
  await assertSucceeds(setDoc(ref, reply({ status: 'no', going: false })));
  await assertSucceeds(setDoc(ref, reply()));
  await assertFails(setDoc(ref, reply({ status: 'no', going: false, prev: 'yes' })));
  await assertSucceeds(setDoc(ref, reply({ status: 'no', going: false, prev: 'yes', reason: 'fell sick' })));
});

test('a member who is not linked cannot reply', async () => {
  await assertFails(setDoc(doc(as(NEWBIE), 'rsvps', `${DATE}_m3`), reply({ memberId: 'm3', uid: NEWBIE })));
});
