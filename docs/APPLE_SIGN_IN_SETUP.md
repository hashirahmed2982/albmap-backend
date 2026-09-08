# Sign in with Apple — setup

The code (backend, iOS, Android, website) is already wired up. What's
missing can only be done by whoever owns the Apple Developer account —
this doc is that checklist. It mirrors the existing Google/Facebook setup
(see `.env.example`), just for Apple's own portal.

You need a paid **Apple Developer Program** membership ($99/yr) — Sign in
with Apple isn't available on a free account.

## 1. Register the App ID's capability

1. [developer.apple.com/account](https://developer.apple.com/account) →
   **Certificates, Identifiers & Profiles** → **Identifiers**.
2. Find the existing App ID for `com.albmap.app` (the iOS app's bundle
   ID — already set in `ios/Runner.xcodeproj`) and open it.
3. Under **Capabilities**, check **Sign In with Apple**. Save.

If `com.albmap.app` isn't registered yet at all (e.g. this is the first
capability the iOS app has needed), create it first: **+** → **App IDs**
→ **App** → Bundle ID `com.albmap.app`, then follow step 3.

## 2. Create a Services ID (needed for Android + the website)

Android has no native Apple SDK, and a website isn't a native app at
all — both sign in through Apple's own web page instead, which is
configured under a separate **Services ID**, not the App ID above.

1. **Identifiers** → **+** → **Services IDs** → Continue.
2. Description: `AlbMap Web`. Identifier: `com.albmap.app.web` (any
   reverse-DNS string not already in use — this exact value becomes
   `APPLE_SERVICES_ID`).
3. Register it, then open it and check **Sign In with Apple** → **Configure**.
4. **Primary App ID**: select `com.albmap.app` (the App ID from step 1) —
   this is what links the Services ID's tokens back to the same app.
5. **Domains and Subdomains**: `albmap.app` (and `api.albmap.app` if
   your backend is on a different subdomain than the website).
6. **Return URLs** — add BOTH of these (one per platform that uses this
   Services ID):
   - `https://albmap.app/login` — the website's sign-in page (Apple
     redirects the browser back here after a popup/redirect sign-in).
   - `https://api.albmap.app/v1/auth/apple/callback` — the backend
     bridge endpoint that hands the result to the **Android** app (see
     `auth.service.js`'s `buildAppleAndroidCallbackRedirect`). Use
     whatever your backend's real public URL actually is instead of
     `api.albmap.app` if it's different.
7. Save, then Continue → Register.

No domain-verification file is required for this (that's only for
Universal Links/Associated Domains, a different feature) — just adding
the Return URLs above is enough.

## 3. Create a Sign in with Apple private key (for email relay + revocation, optional but recommended)

Not required for the login flow itself (which only needs steps 1–2), but
needed if you ever want to detect a user revoking "Sign in with Apple"
from their Apple ID settings, or handle Apple's private relay email
forwarding server-side. Skip this for now unless you need it —
nothing in this app currently uses it.

## 4. Set the environment variables

On the backend server (wherever `albmap-backend` runs — add these to its
`.env`, see `.env.example`):

```
APPLE_BUNDLE_ID=com.albmap.app
APPLE_SERVICES_ID=com.albmap.app.web    # exactly what you typed in step 2.2
APPLE_ANDROID_PACKAGE_ID=com.albmap.app
```

Then run the migration so `users.auth_provider` accepts `'apple'`:

```
npm run db:migrate
```

(or, on an existing production DB you'd rather patch directly:
`mysql -u <user> -p <database> < src/db/migrate-apple-login.sql`)

## 5. Website env var

In `albmap-website`'s `.env`/deployment env:

```
NEXT_PUBLIC_APPLE_CLIENT_ID=com.albmap.app.web   # the Services ID from step 2
```

The redirect URI is hardcoded in `AppleSignInButton.tsx` to
`https://albmap.app/login` — must exactly match one of the Return URLs
from step 2.6. If the website's real domain is ever different, update
both places together.

## 6. iOS — Xcode capability

The entitlement file (`ios/Runner/Runner.entitlements`) already has
`com.apple.developer.applesignin` added. When you next open the project
in Xcode (or run `flutter build ios`/archive for TestFlight/App Store),
Xcode will pick this up automatically as long as your Apple Developer
account/team is signed in there — no extra manual toggle needed, but if
Xcode ever shows a provisioning error mentioning "Sign In with Apple",
open **Runner target → Signing & Capabilities** and confirm it's listed
there (it reads from the entitlements file; this only happens if step 1
above wasn't actually saved on the App ID).

## 7. Android — nothing extra beyond what's already in the code

The manifest change (`SignInWithAppleCallback` activity) is already in
place. Android just needs `APPLE_SERVICES_ID`/step 2 done — no Google
Play Console equivalent step exists for this.

## 8. Test it

- **iOS**: run on a real device or simulator signed into a real Apple
  ID (Sign in with Apple doesn't work in an unsigned-in simulator) —
  tap "Continue with Apple" on the login screen.
- **Android**: tap "Continue with Apple" — this opens a Custom Tab
  pointed at Apple's sign-in page, then bounces back into the app.
  Requires `APPLE_SERVICES_ID` to be set and its Return URL (step 2.6)
  to exactly match the backend's real public URL.
- **Website**: `/login` page, "Continue with Apple" button.

If a sign-in fails, the backend logs the real reason server-side
(`Invalid or expired Apple identity token` usually means
`APPLE_BUNDLE_ID`/`APPLE_SERVICES_ID` don't match what's configured in
the Apple Developer portal, or the Services ID's Primary App ID/Return
URL isn't set up right).
