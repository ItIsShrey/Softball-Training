// Firebase web config for the softball-training-a2e32 project.
// These values identify the project; they are not secrets. Access is controlled by firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyA32Q7Zpu16Yc8kAl-cxHLQ0Alkb9hABss",
  authDomain: "softball-training-a2e32.firebaseapp.com",
  projectId: "softball-training-a2e32",
  storageBucket: "softball-training-a2e32.firebasestorage.app",
  messagingSenderId: "227635910686",
  appId: "1:227635910686:web:adf4be5121303a4c28360f",
};

// Telegram login: the bot and the Worker that checks logins (README, "Telegram login").
export const telegram = {
  bot: 'smusoftball_bot',  // bot username without @
  authUrl: 'https://softball-telegram-auth.shrey-chauhan.workers.dev/auth/telegram',  // Worker URL, e.g. 'https://softball-telegram-auth.<you>.workers.dev/auth/telegram'
};

// The owner's login code. Only the owner can add or remove excos. Keep in step with isOwner() in firestore.rules.
export const owner = 'tg:834667219';
