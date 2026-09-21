const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const store = require('./store');

const JWT_SECRET = process.env.JWT_SECRET || 'axis-dev-secret-change-in-production';
const TOKEN_TTL = '30d';

function publicUser(u) {
  return { id: u.id, handle: u.handle, avatar: u.avatar, city: u.city, balance: u.balance, createdAt: Number(u.created_at) };
}

async function signup({ handle, password, city, avatar }) {
  handle = String(handle || '').trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(handle)) {
    throw httpError(400, 'Handle must be 3-20 characters: letters, numbers, underscore.');
  }
  if (!password || password.length < 8) {
    throw httpError(400, 'Password must be at least 8 characters.');
  }
  const existing = await store.getUserByHandle(handle);
  if (existing) throw httpError(409, 'That handle is already taken.');

  const id = store.uid('u');
  const hash = await bcrypt.hash(password, 12);
  const now = Date.now();
  await store.createUser({ id, handle, passwordHash: hash, avatar: avatar || '🙂', city: city || '', createdAt: now });
  // Every new account is auto-joined to the four default community groups
  // (Axis general, Belgrade social, Novi Sad social, Serbia social) — these
  // are created once, idempotently, at server boot (see server.js).
  await store.joinDefaultGroups(id);

  const user = await store.getUserById(id);
  return { user: publicUser(user), token: issueToken(user) };
}

async function login({ handle, password }) {
  handle = String(handle || '').trim().replace(/^@/, '');
  const user = await store.getUserByHandle(handle);
  if (!user) throw httpError(401, 'Invalid handle or password.');
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) throw httpError(401, 'Invalid handle or password.');
  return { user: publicUser(user), token: issueToken(user) };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, handle: user.handle }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// Express middleware: requires "Authorization: Bearer <token>"
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token.' });
  try {
    const payload = verifyToken(token);
    const user = await store.getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User no longer exists.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = { signup, login, verifyToken, requireAuth, publicUser, JWT_SECRET };
