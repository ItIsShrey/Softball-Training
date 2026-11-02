# SMU Softball Planner

Two pages, hosted on Firebase:

- **`/` (member view)**: members pick their name, enter their 4-digit PIN once, then see upcoming trainings, reply "I'm coming" or "Can't make it", and see their team, game position and batting spot once excos publish them.
- **`/coach` (coach and exco view)**: plan sessions from attendance and the drill library, balance teams by level and gender, set game lineups on a field or list view, manage members and their PINs, and see poll replies.

No build step. The pages are plain HTML and JavaScript that load the Firebase SDK from Google's CDN.

## One-time setup (about 15 minutes)

1. **Create a Firebase project** at https://console.firebase.google.com (the free Spark plan is enough).
2. **Add a web app**: Project settings → Your apps → Web. Copy the `firebaseConfig` values into `public/js/firebase-config.js`.
3. **Turn on sign-in methods**: Authentication → Sign-in method → enable **Google** (for excos) and **Anonymous** (for members).
4. **Create the database**: Firestore Database → Create database → production mode, region `asia-southeast1` (Singapore).
5. **Add excos**: in Firestore, create a collection `admins` and add one document per exco, with the document ID set to their Google email (for example `shrey@gmail.com`). The fields can be empty.
6. **Deploy**:
   ```sh
   npm install -g firebase-tools
   firebase login
   firebase use --add        # pick your project
   firebase deploy           # uploads the pages and the security rules
   ```
   The site is then live at `https://<project-id>.web.app`.
7. **Import the roster**: open `/coach`, sign in, go to Members, and load the backup file (`members` and `drills` JSON) with **Import roster**.
8. **Give out PINs**: on Members, press **Give PINs to everyone without one**, then **Copy PIN list**. Send each member only their own PIN.

## Telegram login (optional, free, no card)

Members and excos can log in with Telegram instead of PIN-only or Google. Telegram signs each login with your bot's token, and a small Cloudflare Worker (`worker/`) checks that signature and hands back a Firebase login. The token stays in Cloudflare.

1. **Create the bot**: in Telegram, message @BotFather → `/newbot` → pick a name and a username ending in `bot`. Keep the token private.
2. **Allow your site**: to @BotFather send `/setdomain`, pick the bot, enter `softball-training-a2e32.web.app`.
3. **Get a Firebase service account key**: Firebase console → ⚙️ Project settings → Service accounts → **Generate new private key**. A JSON file downloads. Don't commit it.
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

How it works for people:
- **Members** tap "Log in with Telegram", then once pick their name and enter their PIN. That links their Telegram for good, on any phone.
- **Excos** can use Telegram too. After their first try, the coach page shows their ID (`tg:<number>`). Add a document with that ID to the `admins` collection. Google email IDs keep working.
- The Members tab shows a **Telegram** badge for linked members.

## Running a training

1. In `/coach`, pick the date. Tick **Members can see this training and reply** and press **Save plan**. The training now shows on the member page.
2. Replies show in Attendance as ✓ and ✕, with a button to tick everyone who said yes.
3. Build the plan and teams. When you're ready, tick **Show teams and game lineups to members** and save again.

## Security

`firestore.rules` controls access:
- Levels, genders, drills and PINs are visible to excos only.
- Members can read names, published trainings and replies. They can only reply for themselves, and only after proving their PIN.
- A 4-digit PIN stops casual impersonation, not a determined attacker. Don't put anything sensitive in a training plan.

## Files

```
public/index.html          member view
public/coach.html          coach and exco view
public/css/app.css         shared styles (light and dark)
public/js/store.js         Firebase setup and a small database wrapper
public/js/firebase-config.js   your project's config (step 2) and Telegram settings
worker/                    Cloudflare Worker for Telegram login
firestore.rules            database security rules
firebase.json              hosting and rules config
```
