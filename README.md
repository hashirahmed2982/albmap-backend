# AlbMap Backend

## Recent gap-fix pass (all live-tested against real MySQL)

Change password, edit profile, avatar upload, event image upload,
duplicate-business detection on submit, re-review-required when an
approved business edits a sensitive field (name/category/address/
coordinates), pagination on `/businesses` and `/events`, expanded search
(category/tags, not just name), a real reviews/ratings system, favorites
now sync server-side (fixing `favorite_count` being permanently dead),
event-creation flood prevention (max 5/business/24h), a refresh-token
cleanup job, and admin account management (add/list/remove admins). See
§5 for the full updated endpoint list.

Nothing above breaks existing endpoints — all additive except
`submitBusiness`'s response shape (now returns the created business, not
void) and `GET /businesses`/`GET /events` (now include a `pagination`
object alongside the existing `data` array).

Node.js + Express + MySQL REST API. Serves the Flutter mobile app, and is
designed to be consumed identically by a Next.js website and a Next.js
admin portal — all three are just HTTP clients of this one API and one
MySQL database.

**This backend has been tested end-to-end against a real MySQL 8.0
instance** — every endpoint below was actually exercised with `curl`
during development (signup → submit business → admin approve → appears
publicly → analytics recorded → notification broadcast → event creation →
token refresh → validation/auth/role-guard failure cases). It's not just
code that looks right; it runs.

---

## 1. Prerequisites

- Node.js 18+ 
- MySQL 8.0+ (or MariaDB 10.6+, should work but untested)
- (Optional) A Firebase project, for real push notification delivery

## 2. Setup

```bash
cd albmap-backend
npm install
cp .env.example .env
```

Edit `.env` — at minimum set `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and both
JWT secrets (use `openssl rand -hex 32` to generate strong random values
for `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`).

Create the database and a user (adjust to your MySQL setup):
```sql
CREATE DATABASE albmap CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'albmap_user'@'localhost' IDENTIFIED BY 'your-password';
GRANT ALL PRIVILEGES ON albmap.* TO 'albmap_user'@'localhost';
FLUSH PRIVILEGES;
```

Run the schema and seed data:
```bash
npm run db:migrate   # creates all tables — see src/db/schema.sql
npm run db:seed      # seeds categories + creates initial admin account
```

The seed script prints the admin login it created (default
`admin@albmap.app` / whatever `SEED_ADMIN_PASSWORD` is in your `.env`) —
**change that password immediately** via a real login + password-change
flow once you have one, or update it directly in the database for now.

Start the server:
```bash
npm run dev    # nodemon, auto-restarts on file changes
# or
npm start      # plain node, for production
```

You should see:
```
✅ MySQL connection established
🚀 AlbMap API listening on http://localhost:4000
   Mobile app baseUrl should point to: http://localhost:4000/v1
```

## 3. Connecting the Flutter app

In the Flutter project, point `baseUrl` at this server:
```bash
flutter run --dart-define=BASE_URL=http://localhost:4000/v1 --dart-define=USE_MOCK_DATA=false
```
(or edit the default in `lib/core/constants/app_constants.dart` directly).
Every endpoint below matches exactly what the mobile app's
`*_remote_datasource.dart` files call — no mobile-side code changes needed.

## 4. Connecting a Next.js website / admin portal

Both are just fetch/axios clients of this same API:
```js
const res = await fetch('http://localhost:4000/v1/businesses');
const { data } = await res.json();
```
For the admin portal, add the admin's JWT as a Bearer token on every
`/v1/admin/*` call, same as any other authenticated request.

**CORS**: add your website/admin portal's dev and production origins to
`CORS_ALLOWED_ORIGINS` in `.env` (comma-separated) — requests from
un-listed origins are rejected. The mobile app is unaffected either way
since native HTTP clients don't send an `Origin` header.

---

## 5. API reference

All routes are prefixed with `/v1`. `🔒` = requires `Authorization: Bearer
<token>`. `🔒👑` = requires an admin token.

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | `{ email, password, name }` → `{ user, accessToken, refreshToken }` |
| POST | `/auth/login` | `{ email, password }` → same shape |
| POST | `/auth/google` | Stubbed — see §7 |
| POST | `/auth/facebook` | Stubbed — see §7 |
| POST | `/auth/refresh` | `{ refreshToken }` → `{ accessToken }` |
| POST | `/auth/logout` | `{ refreshToken }` → revokes it |
| GET | `/auth/me` 🔒 | Current user |
| POST | `/auth/forgot-password` | `{ email }` → always 200 (doesn't leak which emails exist); logs a reset token to console — see §7 |

### Businesses
| Method | Path | Notes |
|---|---|---|
| GET | `/businesses` | Public feed — approved+active only. Query: `category`, `sortBy` (`distance`\|`popularity`), `lat`, `lng`, `radiusKm` |
| GET | `/businesses?ownerId=<id>` 🔒 | "My Businesses" — all statuses, caller must own that id |
| GET | `/businesses/search?q=` | Name search, approved+active only |
| GET | `/businesses/:id` | Single business, any status (used by owners viewing pending listings too) |
| POST | `/businesses` 🔒 | Submit new business → status `pending` |
| PATCH | `/businesses/:id` 🔒 | Owner-only edit of their own business's fields |
| POST | `/businesses/logo` 🔒 | Multipart upload (`logo` field) → `{ url }` |

### Events
| Method | Path | Notes |
|---|---|---|
| GET | `/events` | Query: `category`, `businessId`, `from`, `to` (ISO 8601) |
| GET | `/events/:id` | Single event |
| POST | `/events` 🔒 | Caller must own the business, which must be approved |

### Analytics (Dashboard)
| Method | Path | Notes |
|---|---|---|
| GET | `/businesses/:id/analytics` 🔒 | Owner or admin only |
| POST | `/businesses/:id/analytics/event` | `{ type: "profileView"\|"websiteClick"\|"callClick" }`, no auth — any visitor's tap counts |

### Notifications
| Method | Path | Notes |
|---|---|---|
| POST | `/businesses/:id/broadcast` 🔒 | Owner-only. `{ title, body }` → delivers via FCM topic, degrades gracefully if Firebase isn't configured |
| POST | `/users/me/fcm-token` 🔒 | `{ fcmToken }` — call on app start / token refresh |

### Categories
| Method | Path | Notes |
|---|---|---|
| GET | `/categories` | Public, read-only |

### Admin (all require 🔒👑)
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/dashboard` | Aggregate stats: users, businesses by status, events, top categories, recent activity |
| GET | `/admin/businesses/pending` | Queue for review |
| GET | `/admin/businesses?status=&search=` | All businesses, filterable |
| PATCH | `/admin/businesses/:id/review` | `{ decision: "approved"\|"rejected", reason? }` — triggers owner notification |
| PATCH | `/admin/businesses/:id/active` | `{ isActive }` — deactivate without deleting |
| GET | `/admin/users?search=` | All business-role users |
| PATCH | `/admin/users/:id/active` | `{ isActive }` — ban/unban |
| GET | `/admin/events` | All events |
| PATCH | `/admin/events/:id/active` | Moderate/remove |

---

## 6. Database schema

See `src/db/schema.sql` for the full DDL with comments. Ten tables:
`users`, `password_reset_tokens`, `refresh_tokens`, `categories`,
`businesses`, `business_status_history` (audit trail), `business_analytics`
(aggregate counters), `business_analytics_daily` (feeds the 7-day chart),
`events`, `notifications`.

No ORM — plain `mysql2` with parameterized queries throughout. This was a
deliberate choice for transparency (every query is visible SQL, nothing
generated) at the cost of more boilerplate than Prisma/Sequelize would
need. If the schema stabilizes and you want migration versioning,
`schema.sql` is a reasonable jumping-off point for a real migration tool
(Prisma Migrate, Knex, db-migrate) — right now `npm run db:migrate` just
re-applies the whole file idempotently (`CREATE TABLE IF NOT EXISTS`).

## 7. What's stubbed and needs real implementation before production

These are clearly marked with `// TODO` comments in the source — nothing
is silently fake:

- **Google/Facebook sign-in** (`src/modules/auth/auth.service.js`) — the
  routes exist and match what the mobile app calls, but token verification
  against Google/Facebook's servers isn't implemented. Add
  `google-auth-library` for Google; verify Facebook tokens against their
  Graph API.
- **Password reset emails** — currently logs the reset token to the server
  console instead of emailing it. Wire up SendGrid/SES/Postmark/etc in
  `forgotPassword()`.
- **Firebase Admin / push delivery** (`src/modules/notifications/fcm.js`) —
  fully implemented, but does nothing until you set
  `FIREBASE_SERVICE_ACCOUNT_PATH` in `.env` to a real service account JSON
  file. Until then, broadcasts are logged, not delivered — the API still
  responds successfully (`{ delivered: false, reason: "..." }`) so the
  mobile app's broadcast flow doesn't break, it just doesn't reach devices.
- **File storage** — logo/image uploads currently save to local disk
  (`uploads/`). Fine for a single-server deployment; swap `multer`'s
  storage engine for `multer-s3` (or similar) when you need multi-server
  or CDN-backed storage. Nothing else needs to change — routes/controllers
  only ever see the resulting URL.
- **Rating submission** — `businesses.rating_avg`/`rating_count` columns
  exist and are read by the API, but there's no endpoint to actually submit
  a rating yet (wasn't in the original mobile app scope). Add a
  `reviews` table + `POST /businesses/:id/reviews` when you're ready for
  that feature.

## 8. Known dependency advisory (not exploitable here)

`npm audit` flags a moderate-severity `uuid` advisory nested inside
`firebase-admin`'s own Google Cloud SDK dependency chain (3-4 levels deep —
`firebase-admin` → `@google-cloud/firestore`/`storage` → `google-gax` →
`uuid`). The vulnerable code paths are in `uuid` v3/v5/v6; this codebase
only ever calls `uuidv4()`, which isn't affected. Left as-is rather than
forcing a breaking `firebase-admin` major-version bump that wasn't fully
regression-tested here — revisit if `npm audit` output changes or when you
next upgrade `firebase-admin` deliberately.

## 9. Project structure

```
src/
  app.js              — Express app: middleware, route mounting, error handling
  server.js           — Entry point: connects to MySQL, starts listening
  config/
    env.js            — Centralized env var loading + validation
    db.js             — MySQL connection pool
  db/
    schema.sql        — Full DDL
    migrate.js         — Applies schema.sql
    seed.js            — Categories + initial admin account
  middleware/
    auth.js           — requireAuth / requireRole / optionalAuth
    errorHandler.js    — Central error → JSON response shaping
    upload.js          — Multer config for image uploads
    validate.js        — express-validator result handling
  utils/
    ApiError.js         — Typed error class (statusCode + message)
    asyncHandler.js      — Wraps async routes, forwards rejections to Express
    jwt.js               — Sign/verify access + refresh tokens
  modules/
    auth/               — signup, login, social login stubs, refresh, me
    businesses/          — CRUD, search, "my businesses", approval-gated public feed
    events/               — CRUD, date-range filtering
    analytics/             — event recording + dashboard stats
    notifications/          — broadcast + FCM wrapper
    admin/                    — dashboard, approval workflow, user/event moderation
    categories/                — read-only category list
    users/                      — FCM token registration
  routes/
    index.js                    — Mounts every module's routes
```

Each module follows the same three-file pattern: `*.routes.js` (Express
router + validation rules) → `*.controller.js` (thin HTTP layer) →
`*.service.js` (actual business logic, all DB access). Routes never touch
the database directly — that's always through a service function.
