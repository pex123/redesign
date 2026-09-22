// Optional: creates a handful of demo accounts so new signups have people to
// find/follow/message right away. Safe to run multiple times (skips existing).
// Usage: node src/seed.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const store = require('./store');

const DEMO_USERS = [
  { handle: 'mia', city: 'Belgrade', avatar: '🌙' },
  { handle: 'alex', city: 'Belgrade', avatar: '⚙️' },
  { handle: 'snake', city: 'Belgrade', avatar: '🐍' },
  { handle: 'marko', city: 'Belgrade', avatar: '🔥' },
];
const DEMO_PASSWORD = 'demopass123';

(async () => {
  await store.init();
  for (const u of DEMO_USERS) {
    const existing = await store.getUserByHandle(u.handle);
    if (existing) { console.log(`- ${u.handle} already exists, skipping`); continue; }
    const id = store.uid('u');
    const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
    await store.createUser({ id, handle: u.handle, passwordHash: hash, avatar: u.avatar, city: u.city, createdAt: Date.now() });
    console.log(`+ created demo user @${u.handle} (password: ${DEMO_PASSWORD})`);
  }
  console.log('\nDone. These are real accounts in the real database — log in as any of them to test messaging between two browser tabs/windows.');
  process.exit(0);
})();
