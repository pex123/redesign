require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const store = require('./store');
const paypal = require('./paypal');
const { syncExternalEvents } = require('./eventSources');
const { signup, login, requireAuth, verifyToken, publicUser } = require('./auth');

function todayKey() { return new Date().toISOString().slice(0, 10); } // YYYY-MM-DD, UTC

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─────────────────────────────────────────────────────────
// Presence: userId -> Set of live socket ids (in-memory; resets on
// restart, which only means "everyone shows offline momentarily" — no
// user data is lost, unlike the old SQLite-file approach on ephemeral hosts)
// ─────────────────────────────────────────────────────────
const online = new Map();

function markOnline(userId, socketId) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socketId);
}
function markOffline(userId, socketId) {
  const set = online.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) online.delete(userId);
}
function isOnline(userId) { return online.has(userId); }

async function createNotification(userId, type, payload) {
  const n = { id: store.uid('n'), userId, type, payload: JSON.stringify(payload), createdAt: Date.now() };
  await store.insertNotification(n);
  io.to('user:' + userId).emit('notification', { id: n.id, type, payload, createdAt: n.createdAt, read: false });
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(e => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Internal server error.' });
  });
}

// ═════════════════════════ REST: AUTH ═════════════════════════
app.post('/api/auth/signup', asyncRoute(async (req, res) => {
  const result = await signup(req.body || {});
  res.json(result);
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const result = await login(req.body || {});
  res.json(result);
}));

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), online: true });
});

// ═════════════════════════ REST: USERS / FRIENDS ═════════════════════════
app.get('/api/users/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').replace(/^@/, '').toLowerCase();
  if (!q) return res.json({ users: [] });
  const rows = await store.searchUsers(req.user.handle, q, 10);
  res.json({ users: rows.map(publicUser) });
}));

app.post('/api/friends/:handle', requireAuth, asyncRoute(async (req, res) => {
  const target = await store.getUserByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "Can't friend yourself." });
  await store.addFriendPair(req.user.id, target.id, Date.now());
  await createNotification(target.id, 'friend_request', { from: req.user.handle, message: `@${req.user.handle} added you as a friend.` });
  res.json({ ok: true });
}));

app.delete('/api/friends/:handle', requireAuth, asyncRoute(async (req, res) => {
  const target = await store.getUserByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  await store.removeFriendPair(req.user.id, target.id);
  res.json({ ok: true });
}));

app.get('/api/friends', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listFriends(req.user.id);
  res.json({ friends: rows.map(u => ({ ...publicUser(u), online: isOnline(u.id) })) });
}));

// ═════════════════════════ REST: CHATS ═════════════════════════
app.get('/api/chats', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listChatsForUser(req.user.id);
  const result = await Promise.all(rows.map(async chat => {
    const members = await store.getChatMembers(chat.id);
    const lastMsg = await store.getLastMessage(chat.id);
    const unread = await store.countUnread(chat.id, Number(chat.last_read_at), req.user.handle);
    return {
      id: chat.id, type: chat.type, name: chat.name,
      members: members.map(m => ({ handle: m.handle, avatar: m.avatar, online: isOnline(m.id) })),
      lastMessage: lastMsg ? { from: lastMsg.from_user, text: lastMsg.text, at: Number(lastMsg.created_at) } : null,
      unread
    };
  }));
  res.json({ chats: result });
}));

app.post('/api/chats', requireAuth, asyncRoute(async (req, res) => {
  const { type, name, members } = req.body || {};
  if (!Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'Provide at least one member handle.' });

  const memberUsers = (await Promise.all(members.map(h => store.getUserByHandle(h)))).filter(Boolean);
  if (memberUsers.length === 0) return res.status(404).json({ error: 'No valid members found.' });

  if (type === 'dm' && memberUsers.length === 1) {
    const existing = await store.findExistingDM(req.user.id, memberUsers[0].id);
    if (existing) return res.json({ chatId: existing.id, reused: true });
  }

  const chatId = store.uid('chat');
  const now = Date.now();
  await store.createChat({ id: chatId, type: type === 'group' ? 'group' : 'dm', name: name || null, createdAt: now });
  await store.addChatMember(chatId, req.user.id);
  for (const u of memberUsers) await store.addChatMember(chatId, u.id);

  if (type === 'group') {
    await store.insertMessage({ id: store.uid('m'), chatId, fromUser: 'system', text: `Group created by @${req.user.handle}`, createdAt: now });
  }

  [req.user, ...memberUsers].forEach(u => io.to('user:' + u.id).emit('chat_created', { chatId }));
  for (const u of memberUsers) await createNotification(u.id, 'system', { message: `@${req.user.handle} started a chat with you.`, chatId });

  res.json({ chatId, reused: false });
}));

app.get('/api/chats/:id/messages', requireAuth, asyncRoute(async (req, res) => {
  if (!(await store.isChatMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member of this chat.' });
  const rows = await store.listMessages(req.params.id, 200);
  await store.updateLastRead(req.params.id, req.user.id, Date.now());
  res.json({ messages: rows.map(m => ({ id: m.id, from: m.from_user, text: m.text, at: Number(m.created_at) })) });
}));

// ═════════════════════════ REST: NOTIFICATIONS ═════════════════════════
app.get('/api/notifications', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listNotifications(req.user.id, 50);
  res.json({ notifications: rows.map(n => ({ id: n.id, type: n.type, payload: JSON.parse(n.payload), read: !!n.read, at: Number(n.created_at) })) });
}));

app.post('/api/notifications/:id/read', requireAuth, asyncRoute(async (req, res) => {
  await store.markNotificationRead(req.params.id, req.user.id);
  res.json({ ok: true });
}));

app.get('/api/health', (req, res) => res.json({ ok: true, online: online.size, storage: store.backend }));

// ═════════════════════════ REST: POSTS (feed) ═════════════════════════
app.get('/api/posts', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listFeed(50);
  const posts = await Promise.all(rows.map(async p => {
    const likers = await store.getLikers(p.id);
    const commentCount = await store.getCommentCount(p.id);
    const shareCount = await store.getShareCount(p.id);
    return {
      id: p.id,
      from: p.anon ? 'anon' : p.handle,
      anon: !!p.anon,
      text: p.text,
      at: Number(p.created_at),
      likes: likers.map(l => l.handle),
      likeCount: Number(p.like_count),
      commentCount,
      shareCount
    };
  }));
  res.json({ posts });
}));

app.post('/api/posts', requireAuth, asyncRoute(async (req, res) => {
  const { text, anon } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Post text is required.' });
  const id = store.uid('p');
  await store.createPost({ id, userId: req.user.id, anon: !!anon, text: String(text).trim().slice(0, 2000), createdAt: Date.now() });
  io.emit('new_post', { id }); // broadcast to everyone viewing the feed
  res.json({ id });
}));

app.post('/api/posts/:id/like', requireAuth, asyncRoute(async (req, res) => {
  const post = await store.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const liked = await store.toggleLike(req.params.id, req.user.id);
  res.json({ liked });
}));

// ═════════════════════════ REST: COMMENTS ═════════════════════════
app.get('/api/posts/:id/comments', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listComments(req.params.id);
  res.json({ comments: rows.map(c => ({ id: c.id, from: c.handle, avatar: c.avatar, text: c.text, at: Number(c.created_at) })) });
}));

app.post('/api/posts/:id/comments', requireAuth, asyncRoute(async (req, res) => {
  const post = await store.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const text = String((req.body || {}).text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Comment text is required.' });
  const c = { id: store.uid('c'), postId: req.params.id, userId: req.user.id, text, createdAt: Date.now() };
  await store.insertComment(c);
  const out = { id: c.id, from: req.user.handle, avatar: req.user.avatar, text, at: c.createdAt, postId: req.params.id };
  io.emit('new_comment', out);
  if (post.user_id !== req.user.id) {
    await createNotification(post.user_id, 'comment', { postId: req.params.id, from: req.user.handle, preview: text.slice(0, 80) });
  }
  res.json(out);
}));

// ═════════════════════════ REST: SHARES (reposts) ═════════════════════════
app.post('/api/posts/:id/share', requireAuth, asyncRoute(async (req, res) => {
  const post = await store.getPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const note = String((req.body || {}).note || '').trim().slice(0, 500);
  const s = { id: store.uid('sh'), postId: req.params.id, userId: req.user.id, note, createdAt: Date.now() };
  await store.insertShare(s);
  const shareCount = await store.getShareCount(req.params.id);
  io.emit('new_share', { postId: req.params.id, by: req.user.handle, shareCount });
  if (post.user_id !== req.user.id) {
    await createNotification(post.user_id, 'share', { postId: req.params.id, from: req.user.handle });
  }
  res.json({ ok: true, shareCount });
}));

// ═════════════════════════ REST: WALLET (real internal AXC ledger) ═════════════════════════
app.get('/api/wallet', requireAuth, asyncRoute(async (req, res) => {
  const balance = await store.getBalance(req.user.id);
  const transactions = await store.listTransactions(req.user.id, 100);
  res.json({
    balance,
    paypalConfigured: paypal.configured(),
    transactions: transactions.map(t => ({
      id: t.id, amount: Number(t.amount), type: t.type, note: t.note,
      from: t.from_handle || (t.type.startsWith('paypal') ? 'PayPal' : 'AXIS'),
      to: t.to_handle || (t.type.startsWith('paypal') ? 'PayPal' : 'AXIS'),
      direction: t.to_user_id === req.user.id ? 'in' : 'out',
      at: Number(t.created_at)
    }))
  });
}));

// Real, atomic user-to-user transfer inside the app's own AXC ledger.
app.post('/api/wallet/transfer', requireAuth, asyncRoute(async (req, res) => {
  const { toHandle, amount, note } = req.body || {};
  const target = await store.getUserByHandle(String(toHandle || '').replace(/^@/, ''));
  if (!target) return res.status(404).json({ error: 'Recipient not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "Can't send AXC to yourself." });
  const amt = Number(amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'Enter a valid amount.' });

  const { txId, at } = await store.transferFunds({ fromUserId: req.user.id, toUserId: target.id, amount: amt, type: 'transfer', note: note || '' });
  io.to('user:' + target.id).emit('wallet_update', { reason: 'received', amount: amt, from: req.user.handle });
  io.to('user:' + req.user.id).emit('wallet_update', { reason: 'sent', amount: amt, to: target.handle });
  await createNotification(target.id, 'payment', { from: req.user.handle, amount: amt, message: `@${req.user.handle} sent you ${amt.toFixed(2)} AXC.` });
  res.json({ ok: true, txId, at });
}));

// ── PayPal: real money IN. Buyer approves on PayPal, we capture, then we
//    credit their AXC balance 1:1 — the captured USD lands in the PayPal
//    account tied to your PAYPAL_CLIENT_ID. ──
app.post('/api/wallet/paypal/create-order', requireAuth, asyncRoute(async (req, res) => {
  const amt = Number((req.body || {}).amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'Enter a valid amount.' });
  const order = await paypal.createOrder(amt, `AXC top-up for @${req.user.handle}`);
  res.json(order);
}));

app.post('/api/wallet/paypal/capture/:orderId', requireAuth, asyncRoute(async (req, res) => {
  const result = await paypal.captureOrder(req.params.orderId);
  if (result.status !== 'COMPLETED') return res.status(402).json({ error: 'Payment was not completed.', result });
  const amt = Number(result.amount);
  await store.transferFunds({ fromUserId: null, toUserId: req.user.id, amount: amt, type: 'paypal_topup', note: 'PayPal top-up', provider: 'paypal', providerRef: result.captureId });
  io.to('user:' + req.user.id).emit('wallet_update', { reason: 'topup', amount: amt });
  res.json({ ok: true, credited: amt });
}));

// ── PayPal: real money OUT. Sends AXC balance to the user's own PayPal email. ──
app.post('/api/wallet/paypal/payout', requireAuth, asyncRoute(async (req, res) => {
  const { amount, paypalEmail } = req.body || {};
  const amt = Number(amount);
  if (!(amt > 0)) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!paypalEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypalEmail)) return res.status(400).json({ error: 'Enter a valid PayPal email.' });

  // Debit the ledger FIRST inside a real transaction (throws + aborts if
  // insufficient balance), then call PayPal. If the PayPal call fails, we
  // refund the ledger immediately so no AXC is ever silently lost.
  const debit = await store.transferFunds({ fromUserId: req.user.id, toUserId: null, amount: amt, type: 'paypal_payout_pending', note: `Payout to ${paypalEmail}` });
  try {
    const payout = await paypal.sendPayout(paypalEmail, amt, `AXC cash-out from @${req.user.handle}`);
    io.to('user:' + req.user.id).emit('wallet_update', { reason: 'payout', amount: amt });
    res.json({ ok: true, batchId: payout.batchId, status: payout.status });
  } catch (e) {
    await store.transferFunds({ fromUserId: null, toUserId: req.user.id, amount: amt, type: 'paypal_payout_refund', note: 'Refund: payout failed' });
    throw e;
  }
}));

// ═════════════════════════ REST: ADS (postable + payable in AXC) ═════════════════════════
app.get('/api/ads', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listActiveAds();
  res.json({ ads: rows.map(a => ({ id: a.id, title: a.title, body: a.body, link: a.link, budget: Number(a.budget), spent: Number(a.spent), rewardPerView: Number(a.reward_per_view), by: a.handle })) });
}));

// Posting an ad really deducts the advertiser's AXC budget up front — real
// money (AXC) leaves their balance and is held against the ad, same as any
// real ad platform's prepaid budget.
app.post('/api/ads', requireAuth, asyncRoute(async (req, res) => {
  const { title, body, link, budget, rewardPerView } = req.body || {};
  const budgetAmt = Number(budget);
  const reward = Number(rewardPerView) || 0.05;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Ad title is required.' });
  if (!(budgetAmt > 0)) return res.status(400).json({ error: 'Budget must be a positive AXC amount.' });
  if (!(reward > 0) || reward > budgetAmt) return res.status(400).json({ error: 'Reward per view must be positive and less than the budget.' });

  await store.transferFunds({ fromUserId: req.user.id, toUserId: null, amount: budgetAmt, type: 'ad_budget_hold', note: `Ad budget: ${title}` });
  const id = store.uid('ad');
  await store.createAd({ id, userId: req.user.id, title: String(title).trim().slice(0, 120), body: String(body || '').slice(0, 500), link: String(link || '').slice(0, 300), budget: budgetAmt, rewardPerView: reward, createdAt: Date.now() });
  res.json({ id, ok: true });
}));

// Watching an ad really pays the viewer out of that ad's held budget —
// atomic ledger transfer from the ad's pool (system-held) to the viewer.
app.post('/api/ads/:id/watch', requireAuth, asyncRoute(async (req, res) => {
  const ad = await store.getAd(req.params.id);
  if (!ad || ad.status !== 'active') return res.status(404).json({ error: 'Ad not available.' });
  const day = todayKey();
  if (await store.hasViewedAdToday(ad.id, req.user.id, day)) return res.status(400).json({ error: 'Already watched this ad today.' });
  const remaining = Number(ad.budget) - Number(ad.spent);
  const reward = Math.min(Number(ad.reward_per_view), remaining);
  if (reward <= 0) return res.status(400).json({ error: 'This ad has run out of budget.' });

  await store.recordAdView(ad.id, req.user.id, day, Date.now());
  await store.incrementAdSpent(ad.id, reward);
  await store.transferFunds({ fromUserId: null, toUserId: req.user.id, amount: reward, type: 'ad_reward', note: `Watched ad: ${ad.title}` });
  io.to('user:' + req.user.id).emit('wallet_update', { reason: 'ad_reward', amount: reward });
  res.json({ ok: true, reward });
}));

// ═════════════════════════ REST: STEPS (fed by the browser's real motion sensor) ═════════════════════════
app.post('/api/steps', requireAuth, asyncRoute(async (req, res) => {
  const delta = Math.max(0, Math.min(2000, Math.round(Number((req.body || {}).delta) || 0))); // sanity-clamped per call
  if (delta === 0) return res.json({ steps: (await store.getStepsToday(req.user.id, todayKey()))?.steps || 0 });
  const steps = await store.addSteps(req.user.id, todayKey(), delta);
  res.json({ steps });
}));

app.get('/api/steps/today', requireAuth, asyncRoute(async (req, res) => {
  const row = await store.getStepsToday(req.user.id, todayKey());
  res.json({ steps: row ? Number(row.steps) : 0 });
}));

app.get('/api/steps/leaderboard', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.stepsLeaderboard(todayKey(), 20);
  res.json({ leaderboard: rows.map(r => ({ handle: r.handle, avatar: r.avatar, steps: Number(r.steps) })) });
}));

// Milestone AXC rewards are validated server-side against the REAL recorded
// step count for today (never trusts a client-supplied step number), and
// each milestone can only be claimed once per day — real anti-cheat, real
// ledger credit.
const STEP_MILESTONE_TABLE = [{ steps: 2500, reward: 0.10 }, { steps: 5000, reward: 0.20 }, { steps: 7500, reward: 0.30 }, { steps: 10000, reward: 0.50 }];
app.post('/api/steps/claim-milestone', requireAuth, asyncRoute(async (req, res) => {
  const milestone = Number((req.body || {}).milestone);
  const def = STEP_MILESTONE_TABLE.find(m => m.steps === milestone);
  if (!def) return res.status(400).json({ error: 'Unknown milestone.' });
  const day = todayKey();
  const row = await store.getStepsToday(req.user.id, day);
  const steps = row ? Number(row.steps) : 0;
  if (steps < def.steps) return res.status(400).json({ error: `You need ${def.steps.toLocaleString()} steps today (you have ${steps.toLocaleString()}).` });
  if (await store.hasClaimedMilestone(req.user.id, day, def.steps)) return res.status(400).json({ error: 'Already claimed today.' });
  await store.recordMilestoneClaim(req.user.id, day, def.steps);
  await store.transferFunds({ fromUserId: null, toUserId: req.user.id, amount: def.reward, type: 'step_milestone', note: `${def.steps.toLocaleString()} steps` });
  io.to('user:' + req.user.id).emit('wallet_update', { reason: 'step_milestone', amount: def.reward });
  res.json({ ok: true, reward: def.reward });
}));

// ═════════════════════════ REST: EVENTS / TICKETS (real PayPal checkout) ═════════════════════════
app.get('/api/events', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listEvents();
  res.json({ events: rows.map(e => ({ id: e.id, title: e.title, description: e.description, venue: e.venue, dateText: e.date_text, priceUsd: Number(e.price_usd), currency: e.currency, capacity: e.capacity, sold: Number(e.sold), by: e.seller_handle })) });
}));

app.post('/api/events', requireAuth, asyncRoute(async (req, res) => {
  const { title, description, venue, dateText, priceUsd, capacity } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Event title is required.' });
  if (!(Number(priceUsd) >= 0)) return res.status(400).json({ error: 'Enter a valid price.' });
  const id = store.uid('ev');
  await store.createEvent({ id, userId: req.user.id, title: String(title).trim().slice(0, 150), description: String(description || '').slice(0, 1000), venue: String(venue || '').slice(0, 150), dateText: String(dateText || '').slice(0, 100), priceUsd: Number(priceUsd), currency: 'USD', capacity: capacity ? Number(capacity) : null, createdAt: Date.now() });
  res.json({ id, ok: true });
}));

// Buying a ticket with real money: create a PayPal order for the event price.
app.post('/api/events/:id/checkout', requireAuth, asyncRoute(async (req, res) => {
  const event = await store.getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const order = await paypal.createOrder(Number(event.price_usd), `Ticket: ${event.title}`);
  res.json(order);
}));

// Capture that order, then actually issue the ticket — this only runs after
// PayPal confirms the money has actually been captured.
app.post('/api/events/:id/capture/:orderId', requireAuth, asyncRoute(async (req, res) => {
  const event = await store.getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const result = await paypal.captureOrder(req.params.orderId);
  if (result.status !== 'COMPLETED') return res.status(402).json({ error: 'Payment was not completed.', result });

  const code = store.uid('tix').toUpperCase();
  const id = store.uid('t');
  await store.insertTicket({ id, eventId: event.id, buyerId: req.user.id, pricePaid: Number(result.amount), provider: 'paypal', providerRef: result.captureId, code, createdAt: Date.now() });
  await createNotification(event.user_id, 'ticket_sold', { eventTitle: event.title, buyer: req.user.handle, amount: Number(result.amount) });
  res.json({ ok: true, ticketId: id, code });
}));

// A user can also buy a ticket with their in-app AXC balance instead of PayPal.
app.post('/api/events/:id/buy-with-axc', requireAuth, asyncRoute(async (req, res) => {
  const event = await store.getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const price = Number(event.price_usd);
  await store.transferFunds({ fromUserId: req.user.id, toUserId: event.user_id, amount: price, type: 'ticket_purchase', note: `Ticket: ${event.title}` });
  const code = store.uid('tix').toUpperCase();
  const id = store.uid('t');
  await store.insertTicket({ id, eventId: event.id, buyerId: req.user.id, pricePaid: price, provider: 'axc', providerRef: '', code, createdAt: Date.now() });
  io.to('user:' + event.user_id).emit('wallet_update', { reason: 'ticket_sale', amount: price });
  await createNotification(event.user_id, 'ticket_sold', { eventTitle: event.title, buyer: req.user.handle, amount: price });
  res.json({ ok: true, ticketId: id, code });
}));

app.get('/api/tickets/mine', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listTicketsForUser(req.user.id);
  res.json({ tickets: rows.map(t => ({ id: t.id, title: t.title, code: t.code, pricePaid: Number(t.price_paid), redeemed: !!t.redeemed, at: Number(t.created_at) })) });
}));

app.post('/api/tickets/redeem', requireAuth, asyncRoute(async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  const ticket = await store.getTicketByCode(code);
  if (!ticket) return res.status(404).json({ error: 'Invalid ticket code.' });
  if (ticket.redeemed) return res.status(400).json({ error: 'Ticket already redeemed.' });
  await store.redeemTicket(code);
  res.json({ ok: true });
}));

// ═════════════════════════ REST: CLOSE FRIENDS (pin visibility) ═════════════════════════
app.get('/api/close-friends', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listCloseFriends(req.user.id);
  res.json({ closeFriends: rows.map(publicUser) });
}));
app.post('/api/close-friends/:handle', requireAuth, asyncRoute(async (req, res) => {
  const target = await store.getUserByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!(await store.isFriend(req.user.id, target.id))) return res.status(400).json({ error: 'Add them as a friend first.' });
  await store.addCloseFriend(req.user.id, target.id, Date.now());
  res.json({ ok: true });
}));
app.delete('/api/close-friends/:handle', requireAuth, asyncRoute(async (req, res) => {
  const target = await store.getUserByHandle(req.params.handle);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  await store.removeCloseFriend(req.user.id, target.id);
  res.json({ ok: true });
}));

// ═════════════════════════ REST: MAP PINS (real, user-created only — Event / Meet-up / Friend) ═════════════════════════
// Visibility is enforced server-side: a viewer only ever receives pins they
// are actually allowed to see, computed fresh on every request rather than
// trusting anything the client claims about friendship status.
app.get('/api/pins', requireAuth, asyncRoute(async (req, res) => {
  const all = await store.listAllPinsWithOwner();
  const visible = [];
  for (const p of all) {
    if (p.user_id === req.user.id) { visible.push(p); continue; }
    if (p.visibility === 'close_friends') {
      if (await store.isCloseFriend(p.user_id, req.user.id)) visible.push(p);
    } else { // 'all_friends'
      if (await store.isFriend(p.user_id, req.user.id)) visible.push(p);
    }
  }
  res.json({
    pins: visible.map(p => ({
      id: p.id, type: p.type, title: p.title, subtitle: p.subtitle, description: p.description,
      x: Number(p.x), y: Number(p.y), priceUsd: p.price_usd == null ? null : Number(p.price_usd),
      startsAt: p.starts_at == null ? null : Number(p.starts_at), visibility: p.visibility,
      by: p.handle, avatar: p.avatar, mine: p.user_id === req.user.id, createdAt: Number(p.created_at)
    }))
  });
}));

app.post('/api/pins', requireAuth, asyncRoute(async (req, res) => {
  const { type, title, subtitle, description, x, y, priceUsd, startsAt, visibility } = req.body || {};
  if (!['event', 'meetup'].includes(type)) return res.status(400).json({ error: 'Pin type must be "event" or "meetup".' });
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
  if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || x > 100 || y < 0 || y > 100) return res.status(400).json({ error: 'Pin position (x, y) must be 0-100.' });
  const vis = visibility === 'close_friends' ? 'close_friends' : 'all_friends';
  const id = store.uid('pin');
  await store.createPin({
    id, userId: req.user.id, type, title: String(title).trim().slice(0, 100), subtitle: String(subtitle || '').slice(0, 140),
    description: String(description || '').slice(0, 1000), x, y, priceUsd: priceUsd != null ? Number(priceUsd) : null,
    startsAt: startsAt ? Number(startsAt) : null, visibility: vis, createdAt: Date.now()
  });
  io.emit('pin_created', { id });
  res.json({ id, ok: true });
}));

app.delete('/api/pins/:id', requireAuth, asyncRoute(async (req, res) => {
  const pin = await store.getPin(req.params.id);
  if (!pin) return res.status(404).json({ error: 'Pin not found.' });
  if (pin.user_id !== req.user.id) return res.status(403).json({ error: 'Not your pin.' });
  await store.deletePin(req.params.id, req.user.id);
  io.emit('pin_deleted', { id: req.params.id });
  res.json({ ok: true });
}));

// Sharing your live position on the map as a "Friend" pin — opt-in, one
// active pin per user (re-sharing moves it), visible per the same
// close-friends/all-friends rule as event/meetup pins.
app.post('/api/pins/friend-location', requireAuth, asyncRoute(async (req, res) => {
  const { x, y, visibility } = req.body || {};
  if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || x > 100 || y < 0 || y > 100) return res.status(400).json({ error: 'Position (x, y) must be 0-100.' });
  const vis = visibility === 'close_friends' ? 'close_friends' : 'all_friends';
  const id = await store.upsertFriendLocationPin({ userId: req.user.id, x, y, visibility: vis, createdAt: Date.now() });
  io.emit('pin_created', { id });
  res.json({ ok: true, id });
}));
app.delete('/api/pins/friend-location', requireAuth, asyncRoute(async (req, res) => {
  await store.removeFriendLocationPin(req.user.id);
  res.json({ ok: true });
}));

// ═════════════════════════ REST: MARKETPLACE (real listings, real AXC purchases) ═════════════════════════
app.get('/api/market', requireAuth, asyncRoute(async (req, res) => {
  const category = req.query.category || 'all';
  const rows = await store.listMarketItems(category);
  res.json({ items: rows.map(m => ({ id: m.id, category: m.category, title: m.title, description: m.description, priceAxc: Number(m.price_axc), seller: m.seller_handle, createdAt: Number(m.created_at) })) });
}));
app.post('/api/market', requireAuth, asyncRoute(async (req, res) => {
  const { category, title, description, priceAxc } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
  if (!(Number(priceAxc) > 0)) return res.status(400).json({ error: 'Enter a valid price.' });
  const id = store.uid('mkt');
  await store.createMarketItem({ id, userId: req.user.id, category: category || 'other', title: String(title).trim().slice(0, 120), description: String(description || '').slice(0, 1000), priceAxc: Number(priceAxc), createdAt: Date.now() });
  res.json({ id, ok: true });
}));
app.post('/api/market/:id/buy', requireAuth, asyncRoute(async (req, res) => {
  const item = await store.getMarketItem(req.params.id);
  if (!item || item.sold) return res.status(404).json({ error: 'Item not available.' });
  if (item.user_id === req.user.id) return res.status(400).json({ error: "Can't buy your own listing." });
  await store.transferFunds({ fromUserId: req.user.id, toUserId: item.user_id, amount: Number(item.price_axc), type: 'transfer', note: `Marketplace: ${item.title}` });
  await store.markMarketItemSold(item.id);
  io.to('user:' + item.user_id).emit('wallet_update', { reason: 'received', amount: Number(item.price_axc) });
  res.json({ ok: true });
}));

// ═════════════════════════ REST: EXTERNAL EVENTS (cached aggregation — see src/eventSources.js) ═════════════════════════
app.get('/api/events/external', requireAuth, asyncRoute(async (req, res) => {
  const rows = await store.listExternalEvents();
  res.json({
    events: rows.map(e => ({ id: e.id, source: e.source, title: e.title, venue: e.venue, city: e.city, dateText: e.date_text, startsAt: e.starts_at == null ? null : Number(e.starts_at), priceText: e.price_text, url: e.url, imageUrl: e.image_url, fetchedAt: Number(e.fetched_at) }))
  });
}));

// ═════════════════════════ REST: CART CHECKOUT (the main Tickets-tab flow) ═════════════════════════
// The Tickets tab's browse → add-to-cart → checkout flow deals in multi-tier
// events (e.g. "Early Entry" / "VIP Booth" at different prices) that are
// curated demo listings baked into the page, not rows in the `events` table
// (which only models flat single-price listings created via POST
// /api/events). Rather than fake the payment for these, this real PayPal
// checkout charges the actual cart total, and only after PayPal confirms
// the capture does it issue real tickets — auto-creating a minimal event
// record per cart line (owned by the buyer) purely so each purchased ticket
// has something real to reference and show up in "My Tickets".
app.post('/api/cart/checkout', requireAuth, asyncRoute(async (req, res) => {
  const { items } = req.body || {}; // [{ title, tierName, price, qty }]
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty.' });
  const subtotal = items.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);
  const total = +(subtotal * 1.12).toFixed(2); // matches the 12% service fee shown in the cart UI
  const order = await paypal.createOrder(total, `AXIS tickets (${items.length} item${items.length > 1 ? 's' : ''})`);
  res.json(order);
}));

app.post('/api/cart/capture/:orderId', requireAuth, asyncRoute(async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Cart is empty.' });
  const result = await paypal.captureOrder(req.params.orderId);
  if (result.status !== 'COMPLETED') return res.status(402).json({ error: 'Payment was not completed.', result });

  const tickets = [];
  for (const item of items) {
    const eventId = store.uid('ev');
    await store.createEvent({ id: eventId, userId: req.user.id, title: `${item.title} — ${item.tierName}`, description: '', priceUsd: Number(item.price), currency: 'USD', capacity: null, createdAt: Date.now() });
    for (let q = 0; q < Number(item.qty); q++) {
      const code = store.uid('tix').toUpperCase();
      const ticketId = store.uid('t');
      await store.insertTicket({ id: ticketId, eventId, buyerId: req.user.id, pricePaid: Number(item.price), provider: 'paypal', providerRef: result.captureId, code, createdAt: Date.now() });
      tickets.push({ ticketId, code, title: item.title, tierName: item.tierName });
    }
  }
  res.json({ ok: true, tickets, total: result.amount });
}));

// ═════════════════════════ SOCKET.IO — REAL-TIME LAYER ═════════════════════════
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No auth token provided.'));
    const payload = verifyToken(token);
    const user = await store.getUserById(payload.sub);
    if (!user) return next(new Error('User no longer exists.'));
    socket.user = user;
    next();
  } catch (e) {
    next(new Error('Invalid or expired token.'));
  }
});

io.on('connection', async (socket) => {
  const user = socket.user;
  markOnline(user.id, socket.id);
  socket.join('user:' + user.id);
  const myChats = await store.listChatsForUser(user.id);
  myChats.forEach(c => socket.join('chat:' + c.id));

  const friends = await store.listFriends(user.id);
  friends.forEach(f => io.to('user:' + f.id).emit('presence', { handle: user.handle, online: true }));

  socket.on('send_message', async ({ chatId, text }) => {
    try {
      if (!chatId || !text || !String(text).trim()) return;
      if (!(await store.isChatMember(chatId, user.id))) return socket.emit('error_message', { error: 'Not a member of this chat.' });

      const msg = { id: store.uid('m'), chatId, fromUser: user.handle, text: String(text).trim().slice(0, 2000), createdAt: Date.now() };
      await store.insertMessage(msg);

      const outgoing = { id: msg.id, chatId, from: msg.fromUser, text: msg.text, at: msg.createdAt };
      io.to('chat:' + chatId).emit('new_message', outgoing);

      const members = await store.getChatMembers(chatId);
      for (const m of members) {
        if (m.id === user.id) continue;
        await createNotification(m.id, 'message', { chatId, from: user.handle, preview: msg.text.slice(0, 80) });
      }
    } catch (e) { console.error('send_message error:', e); }
  });

  socket.on('typing', ({ chatId }) => {
    if (!chatId) return;
    socket.to('chat:' + chatId).emit('typing', { chatId, from: user.handle });
  });

  socket.on('join_chat', async ({ chatId }) => {
    if (await store.isChatMember(chatId, user.id)) socket.join('chat:' + chatId);
  });

  // ── Real WebRTC signaling for audio/video calls. The server never sees or
  // touches the actual audio/video — it just relays the SDP offer/answer and
  // ICE candidates the two browsers use to set up a real, direct (or
  // STUN/TURN-relayed) peer-to-peer WebRTC connection. This is genuine call
  // signaling, not a mock overlay. ──
  socket.on('call_invite', async ({ chatId, video }) => {
    if (!(await store.isChatMember(chatId, user.id))) return;
    socket.to('chat:' + chatId).emit('call_invite', { chatId, from: user.handle, video: !!video });
  });
  socket.on('call_accept', ({ chatId, to }) => {
    io.to('chat:' + chatId).emit('call_accept', { chatId, from: user.handle, to });
  });
  socket.on('call_reject', ({ chatId, to }) => {
    io.to('chat:' + chatId).emit('call_reject', { chatId, from: user.handle, to });
  });
  socket.on('call_signal', ({ chatId, to, signal }) => {
    // `signal` carries the WebRTC SDP offer/answer or ICE candidate payload.
    socket.to('chat:' + chatId).emit('call_signal', { chatId, from: user.handle, to, signal });
  });
  socket.on('call_end', ({ chatId }) => {
    socket.to('chat:' + chatId).emit('call_end', { chatId, from: user.handle });
  });

  socket.on('disconnect', () => {
    markOffline(user.id, socket.id);
    if (!isOnline(user.id)) {
      friends.forEach(f => io.to('user:' + f.id).emit('presence', { handle: user.handle, online: false }));
    }
  });
});

const PORT = process.env.PORT || 4000;
store.init().then(async () => {
  await store.ensureDefaultGroups();
  server.listen(PORT, () => console.log(`AXIS backend listening on :${PORT}`));
  // Kick off the external-events sync once at boot (fire-and-forget — a slow
  // or failing external source should never delay the server coming up),
  // then keep it refreshing daily. See src/eventSources.js for the caveat
  // on why these parsers are best-effort/unverified.
  syncExternalEvents().catch(e => console.error('[external-events] initial sync failed:', e.message));
  setInterval(() => { syncExternalEvents().catch(e => console.error('[external-events] sync failed:', e.message)); }, 24 * 60 * 60 * 1000);
}).catch(e => {
  console.error('Failed to initialize storage:', e);
  process.exit(1);
});

module.exports = { app, server, io };
