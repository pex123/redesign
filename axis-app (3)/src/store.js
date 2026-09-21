// Storage layer for AXIS.
//
// If DATABASE_URL is set (e.g. Render/Railway/Supabase Postgres), we use
// Postgres — data survives restarts and redeploys, which matters for a real
// messaging app used across sessions/days/countries.
//
// If DATABASE_URL is NOT set, we fall back to a local SQLite file for
// zero-setup local development. That file is NOT persistent on most free
// hosting platforms (wiped on restart/spin-down) — see README before
// deploying without a DATABASE_URL.
const crypto = require('crypto');

const backend = process.env.DATABASE_URL ? 'pg' : 'sqlite';
let pgPool, sqliteDb;

if (backend === 'pg') {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
  });
} else {
  const Database = require('better-sqlite3');
  const path = require('path');
  sqliteDb = new Database(path.join(__dirname, '..', 'axis.db'));
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
}

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('hex');
}

// Translate `?` placeholders (SQLite style, used throughout this file) to
// Postgres's `$1, $2, ...` style. Lets every query below be written once.
function toPgQuery(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

async function run(sql, params = []) {
  if (backend === 'pg') { await pgPool.query(toPgQuery(sql), params); return; }
  sqliteDb.prepare(sql).run(...params);
}
async function get(sql, params = []) {
  if (backend === 'pg') { const r = await pgPool.query(toPgQuery(sql), params); return r.rows[0] || null; }
  return sqliteDb.prepare(sql).get(...params) || null;
}
async function all(sql, params = []) {
  if (backend === 'pg') { const r = await pgPool.query(toPgQuery(sql), params); return r.rows; }
  return sqliteDb.prepare(sql).all(...params);
}

async function init() {
  const idType = 'TEXT';
  const tsType = backend === 'pg' ? 'BIGINT' : 'INTEGER'; // epoch-ms timestamps overflow INT4, need BIGINT on pg

  const ddl = `
CREATE TABLE IF NOT EXISTS users (
  id ${idType} PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar TEXT DEFAULT '🙂',
  city TEXT DEFAULT '',
  balance REAL DEFAULT 0,
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS friends (
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at ${tsType} NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS chats (
  id ${idType} PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT,
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id ${idType} NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at ${tsType} DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id ${idType} PRIMARY KEY,
  chat_id ${idType} NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  from_user TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id ${idType} PRIMARY KEY,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  read INTEGER DEFAULT 0,
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id ${idType} PRIMARY KEY,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anon INTEGER DEFAULT 0,
  text TEXT NOT NULL,
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id ${idType} NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id ${idType} PRIMARY KEY,
  post_id ${idType} NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  id ${idType} PRIMARY KEY,
  post_id ${idType} NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT DEFAULT '',
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id ${idType} PRIMARY KEY,
  from_user_id ${idType} REFERENCES users(id) ON DELETE SET NULL,
  to_user_id ${idType} REFERENCES users(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  note TEXT DEFAULT '',
  provider TEXT DEFAULT '',
  provider_ref TEXT DEFAULT '',
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS steps_daily (
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  steps INTEGER NOT NULL DEFAULT 0,
  updated_at ${tsType} NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS step_milestone_claims (
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  milestone INTEGER NOT NULL,
  created_at ${tsType} NOT NULL,
  PRIMARY KEY (user_id, day, milestone)
);
CREATE TABLE IF NOT EXISTS ads (
  id ${idType} PRIMARY KEY,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  link TEXT DEFAULT '',
  budget REAL NOT NULL,
  spent REAL NOT NULL DEFAULT 0,
  reward_per_view REAL NOT NULL DEFAULT 0.05,
  status TEXT NOT NULL DEFAULT 'active',
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_views (
  ad_id ${idType} NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  created_at ${tsType} NOT NULL,
  PRIMARY KEY (ad_id, user_id, day)
);
CREATE TABLE IF NOT EXISTS events (
  id ${idType} PRIMARY KEY,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  venue TEXT DEFAULT '',
  date_text TEXT DEFAULT '',
  price_usd REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  capacity INTEGER DEFAULT NULL,
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id ${idType} PRIMARY KEY,
  event_id ${idType} NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  buyer_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  price_paid REAL NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  code TEXT NOT NULL,
  redeemed INTEGER DEFAULT 0,
  created_at ${tsType} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_shares_post ON shares(post_id);
CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions(to_user_id, created_at);
CREATE TABLE IF NOT EXISTS close_friends (
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at ${tsType} NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS pins (
  id ${idType} PRIMARY KEY,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'event' | 'meetup' | 'friend'
  title TEXT NOT NULL,
  subtitle TEXT DEFAULT '',
  description TEXT DEFAULT '',
  x REAL NOT NULL,
  y REAL NOT NULL,
  price_usd REAL,
  starts_at ${tsType},
  visibility TEXT NOT NULL DEFAULT 'all_friends', -- 'close_friends' | 'all_friends'
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS market_items (
  id ${idType} PRIMARY KEY,
  user_id ${idType} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  price_axc REAL NOT NULL,
  sold INTEGER DEFAULT 0,
  created_at ${tsType} NOT NULL
);
CREATE TABLE IF NOT EXISTS external_events (
  id ${idType} PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  venue TEXT DEFAULT '',
  city TEXT DEFAULT '',
  date_text TEXT DEFAULT '',
  starts_at ${tsType},
  price_text TEXT DEFAULT '',
  url TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  fetched_at ${tsType} NOT NULL,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_pins_user ON pins(user_id);
CREATE INDEX IF NOT EXISTS idx_market_sold ON market_items(sold, created_at);
CREATE INDEX IF NOT EXISTS idx_extevents_fetched ON external_events(fetched_at DESC);
`;

  if (backend === 'pg') {
    for (const stmt of ddl.split(';').map(s => s.trim()).filter(Boolean)) {
      await pgPool.query(stmt);
    }
  } else {
    sqliteDb.exec(ddl);
  }
  console.log(`[axis] storage backend: ${backend === 'pg' ? 'PostgreSQL (persistent)' : 'SQLite (local file — NOT persistent on most free hosts, see README)'}`);
}

// ── Users ──
async function createUser({ id, handle, passwordHash, avatar, city, createdAt }) {
  await run(`INSERT INTO users (id, handle, password_hash, avatar, city, balance, created_at) VALUES (?,?,?,?,?,0,?)`,
    [id, handle, passwordHash, avatar, city, createdAt]);
}
function getUserByHandle(handle) { return get(`SELECT * FROM users WHERE handle = ?`, [handle]); }
function getUserById(id) { return get(`SELECT * FROM users WHERE id = ?`, [id]); }
function searchUsers(excludeHandle, q, limit = 10) {
  return all(`SELECT * FROM users WHERE handle != ? AND lower(handle) LIKE ? ORDER BY handle LIMIT ${Number(limit)}`,
    [excludeHandle, `%${q.toLowerCase()}%`]);
}

// ── Friends ──
async function addFriendPair(userId, friendId, now) {
  await run(`INSERT INTO friends (user_id, friend_id, created_at) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM friends WHERE user_id=? AND friend_id=?)`,
    [userId, friendId, now, userId, friendId]);
  await run(`INSERT INTO friends (user_id, friend_id, created_at) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM friends WHERE user_id=? AND friend_id=?)`,
    [friendId, userId, now, friendId, userId]);
}
async function removeFriendPair(userId, friendId) {
  await run(`DELETE FROM friends WHERE user_id = ? AND friend_id = ?`, [userId, friendId]);
  await run(`DELETE FROM friends WHERE user_id = ? AND friend_id = ?`, [friendId, userId]);
}
function listFriends(userId) {
  return all(`SELECT u.* FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?`, [userId]);
}

// ── Chats ──
async function createChat({ id, type, name, createdAt }) {
  await run(`INSERT INTO chats (id, type, name, created_at) VALUES (?,?,?,?)`, [id, type, name || null, createdAt]);
}
async function addChatMember(chatId, userId) {
  await run(`INSERT INTO chat_members (chat_id, user_id, last_read_at) SELECT ?,?,0 WHERE NOT EXISTS (SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?)`,
    [chatId, userId, chatId, userId]);
}
function findExistingDM(userId, otherId) {
  return get(`
    SELECT c.id FROM chats c
    JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
    JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
    WHERE c.type = 'dm'`, [userId, otherId]);
}
function listChatsForUser(userId) {
  return all(`
    SELECT c.*, cm.last_read_at FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
    ORDER BY c.created_at DESC`, [userId]);
}
function getChatMembers(chatId) {
  return all(`SELECT u.id, u.handle, u.avatar FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ?`, [chatId]);
}
async function isChatMember(chatId, userId) {
  return !!(await get(`SELECT 1 as x FROM chat_members WHERE chat_id = ? AND user_id = ?`, [chatId, userId]));
}
function getLastMessage(chatId) {
  return get(`SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`, [chatId]);
}
async function countUnread(chatId, sinceTs, excludeHandle) {
  const row = await get(`SELECT COUNT(*) as c FROM messages WHERE chat_id = ? AND created_at > ? AND from_user != ?`, [chatId, sinceTs || 0, excludeHandle]);
  return Number(row.c);
}
async function updateLastRead(chatId, userId, ts) {
  await run(`UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?`, [ts, chatId, userId]);
}

// ── Messages ──
async function insertMessage({ id, chatId, fromUser, text, createdAt }) {
  await run(`INSERT INTO messages (id, chat_id, from_user, text, created_at) VALUES (?,?,?,?,?)`, [id, chatId, fromUser, text, createdAt]);
}
function listMessages(chatId, limit = 200) {
  return all(`SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT ${Number(limit)}`, [chatId]);
}

// ── Notifications ──
async function insertNotification({ id, userId, type, payload, createdAt }) {
  await run(`INSERT INTO notifications (id, user_id, type, payload, read, created_at) VALUES (?,?,?,?,0,?)`, [id, userId, type, payload, createdAt]);
}
function listNotifications(userId, limit = 50) {
  return all(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${Number(limit)}`, [userId]);
}
async function markNotificationRead(id, userId) {
  await run(`UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?`, [id, userId]);
}

// ── Posts ──
async function createPost({ id, userId, anon, text, createdAt }) {
  await run(`INSERT INTO posts (id, user_id, anon, text, created_at) VALUES (?,?,?,?,?)`, [id, userId, anon ? 1 : 0, text, createdAt]);
}
async function listFeed(limit = 50) {
  const posts = await all(`
    SELECT p.*, u.handle, u.avatar,
      (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) as like_count
    FROM posts p JOIN users u ON u.id = p.user_id
    ORDER BY p.created_at DESC LIMIT ${Number(limit)}`);
  return posts;
}
async function getLikers(postId) {
  return all(`SELECT u.handle FROM post_likes pl JOIN users u ON u.id = pl.user_id WHERE pl.post_id = ?`, [postId]);
}
async function toggleLike(postId, userId) {
  const existing = await get(`SELECT 1 as x FROM post_likes WHERE post_id = ? AND user_id = ?`, [postId, userId]);
  if (existing) { await run(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`, [postId, userId]); return false; }
  await run(`INSERT INTO post_likes (post_id, user_id) VALUES (?,?)`, [postId, userId]);
  return true;
}
function getPost(postId) { return get(`SELECT * FROM posts WHERE id = ?`, [postId]); }
async function getShareCount(postId) {
  const row = await get(`SELECT COUNT(*) as c FROM shares WHERE post_id = ?`, [postId]);
  return Number(row.c);
}
async function getCommentCount(postId) {
  const row = await get(`SELECT COUNT(*) as c FROM comments WHERE post_id = ?`, [postId]);
  return Number(row.c);
}

// ── Comments ──
async function insertComment({ id, postId, userId, text, createdAt }) {
  await run(`INSERT INTO comments (id, post_id, user_id, text, created_at) VALUES (?,?,?,?,?)`, [id, postId, userId, text, createdAt]);
}
function listComments(postId, limit = 200) {
  return all(`SELECT c.*, u.handle, u.avatar FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT ${Number(limit)}`, [postId]);
}

// ── Shares (reposts) ──
async function insertShare({ id, postId, userId, note, createdAt }) {
  await run(`INSERT INTO shares (id, post_id, user_id, note, created_at) VALUES (?,?,?,?,?)`, [id, postId, userId, note || '', createdAt]);
}
function hasShared(postId, userId) { return get(`SELECT 1 as x FROM shares WHERE post_id = ? AND user_id = ?`, [postId, userId]); }

// ── Wallet (internal AXC ledger — real, atomic, persisted; NOT connected to any
//    real-world bank/PayPal account by itself. See server.js for the PayPal
//    top-up/payout endpoints that move real money in and out of this ledger.) ──
async function getBalance(userId) {
  const row = await get(`SELECT balance FROM users WHERE id = ?`, [userId]);
  return row ? Number(row.balance) : 0;
}

// Atomically move `amount` AXC from one user to another (or from/to the system
// when fromUserId/toUserId is null, e.g. a PayPal top-up or ad-watch reward).
// Uses a real DB transaction so a crash mid-transfer can never create or destroy
// money — either both balance updates commit or neither does.
async function transferFunds({ fromUserId, toUserId, amount, type, note, provider, providerRef }) {
  amount = Number(amount);
  if (!(amount > 0)) throw Object.assign(new Error('Amount must be positive.'), { status: 400 });
  const txId = uid('tx');
  const now = Date.now();

  if (backend === 'pg') {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      if (fromUserId) {
        const bal = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [fromUserId]);
        if (!bal.rows[0] || Number(bal.rows[0].balance) < amount) {
          throw Object.assign(new Error('Insufficient balance.'), { status: 400 });
        }
        await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, fromUserId]);
      }
      if (toUserId) {
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, toUserId]);
      }
      await client.query(
        `INSERT INTO wallet_transactions (id, from_user_id, to_user_id, amount, type, note, provider, provider_ref, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [txId, fromUserId || null, toUserId || null, amount, type, note || '', provider || '', providerRef || '', now]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    const txn = sqliteDb.transaction(() => {
      if (fromUserId) {
        const bal = sqliteDb.prepare('SELECT balance FROM users WHERE id = ?').get(fromUserId);
        if (!bal || Number(bal.balance) < amount) {
          throw Object.assign(new Error('Insufficient balance.'), { status: 400 });
        }
        sqliteDb.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, fromUserId);
      }
      if (toUserId) {
        sqliteDb.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, toUserId);
      }
      sqliteDb.prepare(
        `INSERT INTO wallet_transactions (id, from_user_id, to_user_id, amount, type, note, provider, provider_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(txId, fromUserId || null, toUserId || null, amount, type, note || '', provider || '', providerRef || '', now);
    });
    txn();
  }
  return { txId, at: now };
}

function listTransactions(userId, limit = 100) {
  return all(
    `SELECT t.*, fu.handle as from_handle, tu.handle as to_handle FROM wallet_transactions t
     LEFT JOIN users fu ON fu.id = t.from_user_id
     LEFT JOIN users tu ON tu.id = t.to_user_id
     WHERE t.from_user_id = ? OR t.to_user_id = ?
     ORDER BY t.created_at DESC LIMIT ${Number(limit)}`,
    [userId, userId]
  );
}

// ── Steps (for the Earn tab; fed by the browser's real motion sensor, see public/index.html) ──
async function addSteps(userId, day, delta) {
  const now = Date.now();
  await run(
    backend === 'pg'
      ? `INSERT INTO steps_daily (user_id, day, steps, updated_at) VALUES (?,?,?,?)
         ON CONFLICT (user_id, day) DO UPDATE SET steps = steps_daily.steps + EXCLUDED.steps, updated_at = EXCLUDED.updated_at`
      : `INSERT INTO steps_daily (user_id, day, steps, updated_at) VALUES (?,?,?,?)
         ON CONFLICT (user_id, day) DO UPDATE SET steps = steps + excluded.steps, updated_at = excluded.updated_at`,
    [userId, day, delta, now]
  );
  const row = await get(`SELECT steps FROM steps_daily WHERE user_id = ? AND day = ?`, [userId, day]);
  return row ? Number(row.steps) : delta;
}
function getStepsToday(userId, day) { return get(`SELECT steps FROM steps_daily WHERE user_id = ? AND day = ?`, [userId, day]); }
function stepsLeaderboard(day, limit = 20) {
  return all(`SELECT s.steps, u.handle, u.avatar FROM steps_daily s JOIN users u ON u.id = s.user_id WHERE s.day = ? ORDER BY s.steps DESC LIMIT ${Number(limit)}`, [day]);
}
async function hasClaimedMilestone(userId, day, milestone) {
  return !!(await get(`SELECT 1 as x FROM step_milestone_claims WHERE user_id = ? AND day = ? AND milestone = ?`, [userId, day, milestone]));
}
async function recordMilestoneClaim(userId, day, milestone) {
  await run(`INSERT INTO step_milestone_claims (user_id, day, milestone, created_at) VALUES (?,?,?,?)`, [userId, day, milestone, Date.now()]);
}

// ── Ads (advertiser pays AXC budget up front; viewers earn AXC from that
//    budget in real, atomic transfers — see /api/ads/:id/watch in server.js) ──
async function createAd({ id, userId, title, body, link, budget, rewardPerView, createdAt }) {
  await run(`INSERT INTO ads (id, user_id, title, body, link, budget, spent, reward_per_view, status, created_at) VALUES (?,?,?,?,?,?,0,?,'active',?)`,
    [id, userId, title, body || '', link || '', budget, rewardPerView, createdAt]);
}
function listActiveAds(limit = 30) {
  return all(`SELECT a.*, u.handle FROM ads a JOIN users u ON u.id = a.user_id WHERE a.status = 'active' AND a.spent < a.budget ORDER BY a.created_at DESC LIMIT ${Number(limit)}`);
}
function getAd(id) { return get(`SELECT * FROM ads WHERE id = ?`, [id]); }
async function hasViewedAdToday(adId, userId, day) { return !!(await get(`SELECT 1 as x FROM ad_views WHERE ad_id = ? AND user_id = ? AND day = ?`, [adId, userId, day])); }
async function recordAdView(adId, userId, day, createdAt) {
  await run(`INSERT INTO ad_views (ad_id, user_id, day, created_at) VALUES (?,?,?,?)`, [adId, userId, day, createdAt]);
}
async function incrementAdSpent(adId, amount) {
  await run(`UPDATE ads SET spent = spent + ?, status = CASE WHEN spent + ? >= budget THEN 'exhausted' ELSE status END WHERE id = ?`, [amount, amount, adId]);
}

// ── Events / Tickets ──
async function createEvent({ id, userId, title, description, venue, dateText, priceUsd, currency, capacity, createdAt }) {
  await run(`INSERT INTO events (id, user_id, title, description, venue, date_text, price_usd, currency, capacity, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, userId, title, description || '', venue || '', dateText || '', priceUsd, currency || 'USD', capacity ?? null, createdAt]);
}
function listEvents(limit = 50) {
  return all(`SELECT e.*, u.handle as seller_handle,
    (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id) as sold
    FROM events e JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC LIMIT ${Number(limit)}`);
}
function getEvent(id) { return get(`SELECT * FROM events WHERE id = ?`, [id]); }
async function insertTicket({ id, eventId, buyerId, pricePaid, provider, providerRef, code, createdAt }) {
  await run(`INSERT INTO tickets (id, event_id, buyer_id, price_paid, provider, provider_ref, code, redeemed, created_at) VALUES (?,?,?,?,?,?,?,0,?)`,
    [id, eventId, buyerId, pricePaid, provider, providerRef, code, createdAt]);
}
function listTicketsForUser(userId) {
  return all(`SELECT t.*, e.title, e.description FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.buyer_id = ? ORDER BY t.created_at DESC`, [userId]);
}
function getTicketByCode(code) { return get(`SELECT * FROM tickets WHERE code = ?`, [code]); }
async function redeemTicket(code) { await run(`UPDATE tickets SET redeemed = 1 WHERE code = ?`, [code]); }

// ── Close friends (subset of friends who can see 'close_friends'-visibility pins) ──
async function addCloseFriend(userId, friendId, now) {
  await run(`INSERT INTO close_friends (user_id, friend_id, created_at) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM close_friends WHERE user_id=? AND friend_id=?)`,
    [userId, friendId, now, userId, friendId]);
}
async function removeCloseFriend(userId, friendId) {
  await run(`DELETE FROM close_friends WHERE user_id = ? AND friend_id = ?`, [userId, friendId]);
}
function listCloseFriends(userId) {
  return all(`SELECT u.* FROM close_friends cf JOIN users u ON u.id = cf.friend_id WHERE cf.user_id = ?`, [userId]);
}
async function isCloseFriend(userId, otherId) {
  return !!(await get(`SELECT 1 as x FROM close_friends WHERE user_id = ? AND friend_id = ?`, [userId, otherId]));
}
async function isFriend(userId, otherId) {
  return !!(await get(`SELECT 1 as x FROM friends WHERE user_id = ? AND friend_id = ?`, [userId, otherId]));
}

// ── Map pins: real, user-created Event / Meet-up / Friend(-location) pins,
//    with a visibility setting (close friends vs all friends). No pin is
//    ever pre-seeded — the map only ever shows what real users posted. ──
async function createPin({ id, userId, type, title, subtitle, description, x, y, priceUsd, startsAt, visibility, createdAt }) {
  await run(`INSERT INTO pins (id, user_id, type, title, subtitle, description, x, y, price_usd, starts_at, visibility, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, userId, type, title, subtitle || '', description || '', x, y, priceUsd ?? null, startsAt ?? null, visibility || 'all_friends', createdAt]);
}
function getPin(id) { return get(`SELECT * FROM pins WHERE id = ?`, [id]); }
async function deletePin(id, userId) { await run(`DELETE FROM pins WHERE id = ? AND user_id = ?`, [id, userId]); }
// One live "friend location" pin per user — sharing again just moves it (upsert), stopping removes it.
async function upsertFriendLocationPin({ userId, x, y, visibility, createdAt }) {
  await run(`DELETE FROM pins WHERE user_id = ? AND type = 'friend'`, [userId]);
  const id = uid('pin');
  await createPin({ id, userId, type: 'friend', title: '', subtitle: '', description: '', x, y, priceUsd: null, startsAt: null, visibility, createdAt });
  return id;
}
async function removeFriendLocationPin(userId) { await run(`DELETE FROM pins WHERE user_id = ? AND type = 'friend'`, [userId]); }
function listAllPinsWithOwner(limit = 500) {
  return all(`SELECT p.*, u.handle, u.avatar FROM pins p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT ${Number(limit)}`);
}

// ── Marketplace: real listings, real AXC purchases (peer-to-peer transfer) ──
async function createMarketItem({ id, userId, category, title, description, priceAxc, createdAt }) {
  await run(`INSERT INTO market_items (id, user_id, category, title, description, price_axc, sold, created_at) VALUES (?,?,?,?,?,?,0,?)`,
    [id, userId, category, title, description || '', priceAxc, createdAt]);
}
function listMarketItems(category, limit = 100) {
  if (category && category !== 'all') {
    return all(`SELECT m.*, u.handle as seller_handle FROM market_items m JOIN users u ON u.id = m.user_id WHERE m.sold = 0 AND m.category = ? ORDER BY m.created_at DESC LIMIT ${Number(limit)}`, [category]);
  }
  return all(`SELECT m.*, u.handle as seller_handle FROM market_items m JOIN users u ON u.id = m.user_id WHERE m.sold = 0 ORDER BY m.created_at DESC LIMIT ${Number(limit)}`);
}
function getMarketItem(id) { return get(`SELECT * FROM market_items WHERE id = ?`, [id]); }
async function markMarketItemSold(id) { await run(`UPDATE market_items SET sold = 1 WHERE id = ?`, [id]); }

// ── External aggregated events (Serbian ticketing platforms) — cached rows
//    written by a periodic sync job, never fetched live per-request. ──
async function upsertExternalEvent(e) {
  const existing = await get(`SELECT id FROM external_events WHERE source = ? AND source_id = ?`, [e.source, e.sourceId]);
  if (existing) {
    await run(`UPDATE external_events SET title=?, venue=?, city=?, date_text=?, starts_at=?, price_text=?, url=?, image_url=?, fetched_at=? WHERE id=?`,
      [e.title, e.venue || '', e.city || '', e.dateText || '', e.startsAt ?? null, e.priceText || '', e.url, e.imageUrl || '', e.fetchedAt, existing.id]);
    return existing.id;
  }
  const id = uid('ext');
  await run(`INSERT INTO external_events (id, source, source_id, title, venue, city, date_text, starts_at, price_text, url, image_url, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, e.source, e.sourceId, e.title, e.venue || '', e.city || '', e.dateText || '', e.startsAt ?? null, e.priceText || '', e.url, e.imageUrl || '', e.fetchedAt]);
  return id;
}
function listExternalEvents(limit = 100) {
  return all(`SELECT * FROM external_events ORDER BY COALESCE(starts_at, fetched_at) ASC LIMIT ${Number(limit)}`);
}

// ── Default community groups: created once (idempotent, fixed ids), every
//    new signup is auto-joined to all of them. ──
const DEFAULT_GROUPS = [
  { id: 'grp_axis_general', name: 'Axis general' },
  { id: 'grp_belgrade_social', name: 'Belgrade social' },
  { id: 'grp_novisad_social', name: 'Novi Sad social' },
  { id: 'grp_serbia_social', name: 'Serbia social' },
];
async function ensureDefaultGroups() {
  for (const g of DEFAULT_GROUPS) {
    const existing = await get(`SELECT id FROM chats WHERE id = ?`, [g.id]);
    if (!existing) await run(`INSERT INTO chats (id, type, name, created_at) VALUES (?,'group',?,?)`, [g.id, g.name, Date.now()]);
  }
}
async function joinDefaultGroups(userId) {
  for (const g of DEFAULT_GROUPS) await addChatMember(g.id, userId);
}

module.exports = {
  backend, uid, init,
  createUser, getUserByHandle, getUserById, searchUsers,
  addFriendPair, removeFriendPair, listFriends,
  createChat, addChatMember, findExistingDM, listChatsForUser, getChatMembers, isChatMember,
  getLastMessage, countUnread, updateLastRead,
  insertMessage, listMessages,
  insertNotification, listNotifications, markNotificationRead,
  createPost, listFeed, getLikers, toggleLike, getPost, getShareCount, getCommentCount,
  insertComment, listComments,
  insertShare, hasShared,
  getBalance, transferFunds, listTransactions,
  addSteps, getStepsToday, stepsLeaderboard, hasClaimedMilestone, recordMilestoneClaim,
  createAd, listActiveAds, getAd, hasViewedAdToday, recordAdView, incrementAdSpent,
  createEvent, listEvents, getEvent, insertTicket, listTicketsForUser, getTicketByCode, redeemTicket,
  addCloseFriend, removeCloseFriend, listCloseFriends, isCloseFriend, isFriend,
  createPin, getPin, deletePin, upsertFriendLocationPin, removeFriendLocationPin, listAllPinsWithOwner,
  createMarketItem, listMarketItems, getMarketItem, markMarketItemSold,
  upsertExternalEvent, listExternalEvents,
  DEFAULT_GROUPS, ensureDefaultGroups, joinDefaultGroups,
};
