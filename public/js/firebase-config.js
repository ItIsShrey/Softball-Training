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

// Telegram login. Fill both after creating the bot and deploying the Worker (README, "Telegram login").
// Leave them empty to use name + PIN only.
export const telegram = {
  bot: '',      // bot username without @, e.g. 'smusoftball_bot'
  authUrl: '',  // Worker URL, e.g. 'https://softball-telegram-auth.<you>.workers.dev/auth/telegram'
};
