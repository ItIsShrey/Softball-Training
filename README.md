# SMU Softball Planner

Two pages, hosted on Firebase:

- **`/` (member view)**: members log in with Telegram, get linked to their name once, then see upcoming trainings and reply "I'm coming", "Coming late", "Leaving early" or "Can't make it". They see their team, game position and batting spot once excos publish them.
- **`/coach` (coach and exco view)**: opens on a month calendar with planned days highlighted. Tap a day to view its plan or make one. Plan sessions from attendance and the drill library, balance teams by level and gender, set game lineups on a field or list view, manage members, and see replies with reasons and last-minute changes.

No build step. The pages are plain HTML and JavaScript that load the Firebase SDK from Google's CDN.

## One-time setup

1. **Create a Firebase project** at https://console.firebase.google.com (the free Spark plan is enough).
2. **Add a web app**: Project settings → Your apps → Web. Copy the `firebaseConfig` values into `public/js/firebase-config.js`.
3. **Turn on Authentication**: Authentication → Get started. No sign-in providers need to be on: logins come from the Telegram Worker below. Leave **Anonymous** and **Google** off.
4. **Create the database**: Firestore Database → Create database → production mode, region `asia-southeast1` (Singapore).
5. **Set the owner**: the owner is the only one who can add or remove excos. Put your code (`tg:<number>`, shown on your profile) in `owner` in `public/js/firebase-config.js` and in `isOwner()` in `firestore.rules`. The owner counts as an exco without an `admins` entry.
6. **Deploy**:
   ```sh
   npm install -g firebase-tools
   firebase login
   firebase use --add        # pick your project
   firebase deploy           # uploads the pages and the security rules
   ```
   The site is then live at `https://<project-id>.web.app`.
7. **Import the roster**: open `/coach`, log in, go to Members, and load the backup file (`members` and `drills` JSON) with **Import roster**.
8. **Link members**: add each member's Telegram @username on Members, one at a time or with **Paste a list**. They're linked automatically when they log in. Anyone without a match picks their name and an exco approves them under **New logins**.

## Telegram login

Telegram signs each login with your bot's token, and a small Cloudflare Worker (`worker/`) checks that signature and hands back a Firebase login. The token stays in Cloudflare.

1. **Create the bot**: in Telegram, message @BotFather → `/newbot` → pick a name and a username ending in `bot`. Keep the token private.
2. **Allow your site**: to @BotFather send `/setdomain`, pick the bot, enter `softball-training-a2e32.web.app`.
3. **Get a Firebase service account key**: Firebase console → ⚙️ Project settings → Service accounts → **Generate new private key**. A JSON file downloads. Don't commit it, and delete it once the secrets below are set.
4. **Deploy the Worker** (free Cloudflare account, no card):
   ```sh
   cd worker
   npx wrangler login
   npx wrangler secret put BOT_TOKEN              # paste the BotFather token
   npx wrangler secret put FIREBASE_CLIENT_EMAIL  # paste "client_email" from the JSON
   npx wrangler secret put FIREBASE_PRIVATE_KEY   # paste "private_key" from the JSON, including the BEGIN/END lines
   npx wrangler deploy
   ```
   It prints a URL like `https://softball-telegram-auth.<you>.workers.dev`.
5. **Turn it on in the site**: in `public/js/firebase-config.js` set `telegram.bot` to the bot username (no @) and `telegram.authUrl` to the Worker URL plus `/auth/telegram`. Run `firebase deploy` again.

### Club group only

Set `GROUP_CHAT_ID` in `worker/wrangler.toml` to the club's Telegram group ID and add the bot to that group. Then only people in the group can log in. `ALWAYS_ALLOW` lists Telegram IDs that can always log in (the owner), so a wrong group ID can't lock you out. Run `npx wrangler deploy` after changing either.

To find a group's ID, open the group in Telegram Web (web.telegram.org/a): the address ends in `#-100…`, and that number, minus sign included, is the ID.

### Exco alerts for last-minute changes

Set `EXCO_CHAT_ID` in `worker/wrangler.toml` to the excos' Telegram chat ID and add the bot to that chat, then `npx wrangler deploy`. When a member changes their reply in the 6 hours before a training (coming late, leaving early, or a yes turned into a no), the bot posts it there with their reason. The coach view also shows these under **Last-minute changes** on the calendar.

### Posting trainings to the group

In the coach view, a training that's saved with "Members can see this training" ticked has a **Post to the Telegram group** button. The bot posts the date, time and venue with a "Reply in the app" button. It posts to `ANNOUNCE_CHAT_ID`, or to `GROUP_CHAT_ID` when that's empty, so add the bot to that chat. Only excos can post: the Worker checks the Firebase login and the `admins` list.

How it works for people:
- **Members** tap "Log in with Telegram". If an exco recorded their @username they're in straight away; otherwise they pick their name once and an exco approves it.
- **Excos** log in on the same page as members. Their code (`tg:<number>`) is on their profile. The owner pastes it under Members, then Excos, and they get a Coach view button.

## Deploy on merge

`.github/workflows/deploy.yml` puts the site live whenever something is merged into `main`. It needs one GitHub secret, `FIREBASE_SERVICE_ACCOUNT`: the whole service account JSON from step 3 of Telegram login (or a new key from the same page). Add it on GitHub under Settings → Secrets and variables → Actions → New repository secret, or from the repo folder:

```sh
gh secret set FIREBASE_SERVICE_ACCOUNT < path/to/key.json
```

Security rules are not deployed automatically. After a change to `firestore.rules` is merged, run `firebase deploy --only firestore:rules`.

## Rules tests

`tests/rules.test.js` checks `firestore.rules` against the Firestore emulator. GitHub runs it on every pull request. To run it yourself (needs Java 11 or newer):

```sh
cd tests
npm install
npm test
```

The tests use a fake project, so they never touch the real database or its daily limits.

## Running a training

1. In `/coach`, pick the date. Tick **Members can see this training and reply** and press **Save plan**. The training now shows on the member page.
2. Replies show in Attendance: ✓ coming, L coming late, E leaving early, ✕ can't make it. **Late, leaving early and reasons** lists who and why, and a button ticks everyone who's coming.
3. Build the plan and teams. When you're ready, tick **Show teams and game lineups to members** and save again.

## Security

`firestore.rules` controls access:
- Only Telegram logins get anything. With `GROUP_CHAT_ID` set, only club group members can log in.
- A new login can read the list of names, to find their own. Trainings and replies need a login linked to a name.
- Levels, genders and drills are visible to excos only. Only the owner adds or removes excos.
- Members can only reply for themselves. Coming late, leaving early, or changing a yes to a no needs a reason.
- Don't put anything sensitive in a training plan.

## Files

```
public/index.html          member view
public/coach.html          coach and exco view
public/css/app.css         shared styles (light and dark)
public/js/store.js         Firebase setup and a small database wrapper
public/js/firebase-config.js   your project's config, Telegram settings and the owner
worker/                    Cloudflare Worker for Telegram login and exco alerts
firestore.rules            database security rules
tests/                     rules tests (Firestore emulator)
.github/workflows/         deploy on merge, rules tests on pull requests
firebase.json              hosting, rules and emulator config
```
