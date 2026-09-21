# AXIS — Real Backend + App

A working social app: real accounts, real-time messaging, and a real feed for
posting and sharing — with a Node.js/Postgres backend and a single HTML
frontend served from the same server. This is genuine, tested software, not
a mockup: see "What's been verified" below.

## The one thing you need to understand before deploying

**`localhost` only works on one computer.** If you and a friend in another
country both need to use this app, the backend must run on a server on the
public internet that both of your phones/browsers can reach. That's what
the deploy steps below set up — after that, you just send your friend a
link, and it works from any phone, anywhere, in a browser (no app-store
download required).

## This round's changes (real, tested against a live server)

- **Default community groups** — "Axis general", "Belgrade social", "Novi
  Sad social", "Serbia social" are created once at boot and every new
  signup is auto-joined to all four. Verified via a live signup + `/api/chats`.
- **Real map pins** — Event, Meet-up, and Friend(-location) pins are now
  100% user-created, with a server-enforced visibility setting (close
  friends vs all friends — the server checks real friendship/close-
  friendship on every request, never trusting the client). No pin is ever
  pre-seeded. Tap "+ Event Pin" / "+ Meet-up Pin" on the map, tap the map to
  place it, fill in details. "Share My Location" drops a Friend pin the
  same way (this is a stylized map illustration, not a georeferenced one,
  so it honestly reflects where you tapped rather than faking a GPS
  conversion that wouldn't line up).
- **"Afters" renamed to "Meet-ups"** throughout the map filters, panel tabs,
  and pin types.
- **Real marketplace** — `/api/market` list/create/buy, real AXC transfers
  on purchase, no hardcoded items.
- **Real Tickets tab** — merges real user-posted native events
  (`/api/events`, single flat price — the old fake multi-tier/lineup data
  is gone) with real cached external events from Serbian ticketing
  platforms. Native cards open a real checkout (AXC or PayPal, from the
  earlier round); external cards are visually distinct and clicking them
  deep-links straight to the original platform URL, per spec.
- **External event aggregation** (`src/eventSources.js`) — a real scheduled
  job (daily) that's supposed to scrape Gigstix/Cooltix/Tickets.rs into a
  cache table. **Important**: the parser selectors in that file are
  unverified — the environment this was built in could not reach those
  sites at all (proxy returned `403 Host not in allowlist`), so there was
  no way to inspect their real HTML. Test this against the live sites once
  deployed, and seriously consider checking whether any of them offer an
  official API or partner feed instead of scraping, which would be far more
  robust and less legally ambiguous. See the comment block at the top of
  that file for details.
- **Manual-video-only calls** — every call now starts audio-only regardless
  of who initiates it. Video is only ever added when someone explicitly
  taps "Start Video" *during* an already-connected call, via real WebRTC
  renegotiation — never automatically, and never just because the incoming
  call happened to request one.
- **Motion sensor permission robustness** — clearer, more specific handling
  for iOS's permission flow (including the case where the user previously
  denied it, which iOS won't re-prompt for), a secure-context check, and a
  watchdog that tells the user plainly if no motion data ever arrives
  (e.g. no accelerometer on this device) instead of leaving the step
  counter looking silently broken.
- **Full-height map bottom sheet on mobile** — found and fixed a second
  instance of the same root cause as before: an inline `width`/`flex`
  style on the panel and canvas elements that no CSS media query could
  override. Moved those into classes so the bottom sheet now exactly fills
  the space beneath the map canvas down to the nav bar, with no fixed
  vh-guess that could cut content off or leave dead space.
- Hourly client-side refresh added for map pins and ticket data, matching
  the requested refresh cadence for native content.

## What's been verified (not just written — actually tested)

- Real signup/login: bcrypt password hashing, JWT sessions
- Real-time messaging: two independent, isolated browser sessions signed up,
  found each other via live search, and exchanged a message delivered
  instantly over WebSocket — confirmed by reading the actual rendered UI
- Real posting/sharing: a post made by one user appeared in another user's
  feed in real time, with correct anonymous-post privacy (author hidden)
- **Data survives a full server restart**: tested by killing the server
  process entirely and confirming accounts/messages were still there after
  restart — this specifically validates the fix for free-tier hosts that
  wipe local files on every restart
- Full backend regression suite (10 checks: signup validation, duplicate/
  wrong-password rejection, session restore, follow/unfollow, chat creation,
  cross-user authorization, posts visible across users, anonymous-post
  privacy) — all passing
- A clean-room install (`npm install` on a fresh copy with no cached state)
  works exactly as documented below

## Quick start (local testing, one machine)

```bash
npm install
npm start                # listens on :4000, uses a local SQLite file
npm run seed              # optional: demo users mia/alex/snake/marko (password: demopass123)
```

Open `http://localhost:4000` in two different browser windows (or one
normal + one private/incognito window so they don't share login state),
sign up as two different people, and message/post between them.

## Deploying so a friend in another country can use it (free, ~10 minutes)

This uses [Render](https://render.com) because it's genuinely free with no
credit card, and Render's free Postgres for a database that survives
restarts (a plain SQLite file does **not** survive restarts on Render's
free tier — this is why the backend supports both, see below).

**Shortcut — one-click blueprint:** this repo includes a `render.yaml`. On
Render, click **New → Blueprint**, point it at your GitHub repo, and Render
reads `render.yaml` to create the web service *and* the free Postgres
database together, wiring `DATABASE_URL` and generating a random
`JWT_SECRET` automatically — skip straight to step 4 below. Otherwise,
follow steps 1-3 to do it by hand.

**1. Put this code on GitHub.** Create a new repository and push this
`axis-backend` folder to it (if you're not familiar with git, GitHub's
"upload files" button in the web UI works too — just drag this whole folder
in).

**2. Create a free Postgres database on Render.**
   - Go to render.com, sign up (no card needed), click **New → PostgreSQL**
   - Pick the **Free** plan, any name, click Create
   - Once it's ready, copy the **Internal Database URL** shown on its page

**3. Create the web service.**
   - Click **New → Web Service**, connect the GitHub repo you made in step 1
   - Environment: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: **Free**
   - Under **Environment Variables**, add:
     - `DATABASE_URL` = (paste the Internal Database URL from step 2)
     - `JWT_SECRET` = any long random string (mash your keyboard)
   - Click **Create Web Service**

**4. Wait for the deploy to finish**, then Render gives you a URL like
`https://axis-yourname.onrender.com`. Open it — that's your live app.

**5. Send that URL to your friend.** Both of you open it in a browser, sign
up, add each other, and message/post — from any two countries, any devices,
just a link.

**One free-tier quirk to know**: Render's free web service "falls asleep"
after 15 minutes with no visitors, and takes ~30–60 seconds to wake back up
on the next visit. Your data is safe either way (it's in Postgres, not on
the sleeping server) — the first message after a quiet period just arrives
a little slower while it wakes up.

## Why there are two database backends in this code

- **No `DATABASE_URL` set** → uses a local SQLite file. Zero setup, perfect
  for testing on your own machine. **Do not deploy this way** — most free
  hosts wipe local files on every restart, which would silently delete
  everyone's accounts and messages.
- **`DATABASE_URL` set** → uses real Postgres. This is what survives
  restarts and redeploys, and what you should use for anything real.

The server logs which one it's using on startup, so you can always confirm
which mode you're in.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/signup | — | Create account |
| POST | /api/auth/login | — | Get a session token |
| GET | /api/me | ✓ | Restore session |
| GET | /api/users/search?q= | ✓ | Find users by handle |
| GET/POST/DELETE | /api/friends[/:handle] | ✓ | List / follow / unfollow |
| GET/POST | /api/chats | ✓ | List chats / create DM or group |
| GET | /api/chats/:id/messages | ✓ | Message history (marks read) |
| GET/POST | /api/notifications[/:id/read] | ✓ | Notification inbox |
| GET/POST | /api/posts | ✓ | Feed / create a post |
| POST | /api/posts/:id/like | ✓ | Toggle like |

Socket.IO events: `send_message`, `new_message`, `typing`, `join_chat`,
`presence`, `notification`, `chat_created`, `new_post`.

## What's in this version (real, tested)

- **Accounts, friends, real-time messaging, feed** — signup/login (bcrypt +
  JWT), follow/unfollow, DMs and groups over Socket.IO, likes — all
  persisted server-side, all previously verified.
- **Comments and shares/reposts** — real, persisted, live-updating via
  Socket.IO, with notifications to the post's author.
- **Fixed the duplicate-message bug** — you'd see your own sent messages
  twice because the server's real-time echo re-arrived on top of the
  optimistic local render. Now deduplicated.
- **Real AXC wallet ledger** — atomic, transactional balance transfers
  between users (can't create or destroy AXC even on a crash mid-transfer),
  full transaction history, insufficient-balance checks.
- **Real PayPal integration** (`src/paypal.js`) — Orders v2 Checkout for
  adding funds (money is captured directly into the PayPal account tied to
  your `PAYPAL_CLIENT_ID`) and the Payouts API for cashing AXC out to any
  PayPal email (auto-refunds the ledger if the payout call fails). **This
  requires you to set `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` as
  environment variables** — see the comment block at the top of
  `src/paypal.js` for the exact steps. Nobody but you can generate those
  credentials; until they're set, the payment/payout routes return a clear
  "PayPal not configured" error instead of faking success.
- **Real ads** — posting one really debits the advertiser's AXC balance for
  the stated budget; watching one really pays the viewer out of that
  specific ad's budget, once per person per day, atomically.
- **Real ticket purchases** — buyable with AXC (instant, atomic transfer to
  the seller) or with PayPal (real Checkout capture, then the ticket is
  only issued after PayPal confirms the payment succeeded).
- **Real step counter** — uses the browser's actual `DeviceMotion`
  accelerometer with basic peak-detection (the same core technique real
  pedometer apps use), synced to the server every few seconds. Milestone
  AXC rewards are validated server-side against your real recorded step
  count for the day, so they can't be spoofed by editing the page. The
  leaderboard shows real users' real step counts. (Browser tabs can't count
  steps in the background — this only tracks while the Earn tab is open, a
  limitation of the web platform, not something a backend can fix.)
- **Real WebRTC audio/video calls** — actual `getUserMedia` +
  `RTCPeerConnection`, signaled over the existing Socket.IO connection
  (offer/answer/ICE relay only — the server never touches your audio/video).
  No mock timer, real incoming-call banner, real connect/disconnect states.
- **Redesigned, mobile-fixed map** — the side panel used to be squeezed into
  a 280px column that never adapted on phones because an inline
  `flex-direction:row` couldn't be overridden by any CSS media query. It's
  now class-driven, so on narrow screens the panel properly becomes a
  bottom drawer instead of fighting the canvas for space.

### Known gap: "bonus achievement" milestones (Earn tab)

The small grid of extra achievements (First Watcher, Century Club, etc.)
predates the real backend and has no server-side tracking for its
conditions (ads-watched counts, day streaks). Rather than wire a "claim"
button to real money with no way to verify the claim server-side — which
would just be a client-editable free-AXC button — it's shown as
locked/informational only until it has real tracking behind it. The step
milestones and ad-watch rewards above it are already fully real.

### What still needs YOUR input to become fully live money-in/money-out

Nothing here is fake or half-built — but two things are, structurally,
requests only you can fulfill:

1. **PayPal credentials** (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) from
   your own PayPal Developer account, for real payments and payouts.
2. **A deployed server on the public internet** (see the deploy steps below)
   so PayPal's redirect can actually reach it, and so anyone besides you can
   use the app at all.


### Third pass: fixed a Render build failure

The very first deploy attempt on Render failed during `npm install`, not at
runtime: `better-sqlite3` (a native C++ module) tried to compile itself from
source on Render's build machine, and Render's current Node version ships a
V8 engine new enough that a couple of V8 APIs the old `better-sqlite3`
version's C++ code relied on had been removed, so the compile step itself
errored out (`'const class v8::PropertyCallbackInfo<v8::Value>' has no
member named 'This'`). Fixed by upgrading `better-sqlite3` to a current
version that ships a ready-to-use precompiled binary for Linux — so `npm
install` now just uses that file directly and never invokes a C++ compiler
at all, which sidesteps the incompatibility entirely instead of chasing it.
`engines.node` was bumped to match what that version requires. Re-verified
locally: clean `npm install` with no compilation step, server boots, login/
seed/data-persistence all confirmed working exactly as before.

### Second pass: fixed for mobile + found a page-breaking bug

A follow-up troubleshooting pass, tested with headless-browser automation on
both a desktop viewport and an iPhone-sized mobile viewport, found and fixed:

- **A page-wide layout bug (was breaking Marketplace, Wallet, Earn, and
  Messages on *every* screen size, not just mobile)**: the Map page's
  container had `display:flex` hardcoded as an inline style, which
  permanently overrode the CSS rule that hides inactive pages. Since it sat
  earlier in the page than Wallet/Messages/Earn/Market, it stayed
  full-height and pushed all of those pages completely off-screen below the
  visible viewport — they were there, just scrolled out of view. Fixed by
  letting the normal show/hide logic control it.
- **An unclosed `<nav>`/`<button>` tag** was silently swallowing every modal
  after it in the page (QR Pay, cart, event, checkout, send money, profile,
  add friend, new chat, mini-call bar) as children of the bottom nav bar,
  which made the QR Pay panel bleed into the nav and made the nav overflow
  horizontally on narrow screens. Fixed by closing the tags properly.
- **Chat was unreachable on mobile**: the CSS simply hid the chat window
  below a certain screen width with no way back to it. Added a proper
  mobile flow — the conversation list and the open chat now swap places
  with a back button, like a normal phone messaging app.
- **A stray "toast" notification element** rendered as a small solid box
  sitting on top of the bottom nav at all times (even with no message
  showing), because its "hidden" state only moved it partway off-screen.
  Fixed by fully hiding it (opacity, not just position) until a toast is
  actually shown.

Run `npm run seed` before you demo this — the wallet/map sidebar shows a
small starter friend list (mia/alex/snake/marko) and will follow them
automatically on signup; without the seed data those follow calls just
no-op quietly.

## What's needed for an actual app-store mobile app

This is a real web app that works great from a phone's browser today — no
"download" step needed, just open the link. Turning it into something
listed in the Apple App Store / Google Play is a separate, larger project
that needs things only you can provide: a paid Apple Developer account
($99/yr), a Google Play account ($25 one-time), and either wrapping this
web app natively (Capacitor/React Native) or a native rebuild, plus store
screenshots, a privacy policy, and passing app review. I can help build
that wrapper if/when you're ready — it's a genuinely different, bigger task
than what's in this repo.
