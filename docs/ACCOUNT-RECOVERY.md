# Password recovery — contract and acceptance

13 September 2026. Password recovery passed **472/472 serial tests** in **123.381374167 seconds**, with zero failures, skips or cancellations; **20 focused cases** in **2.916794166 seconds**; and **12/12 controlled browser groups** on **Node 24.13.0**. Final build/package/compiled-runtime checks passed on **229 unchanged source files**, fingerprint **`f8cbd686c74f4a465f6d70e7e58194d8e6f5ad2c13801f93da5e757c4601ef9b`**. The existing 47 matrix IDs, original criteria and earlier evidence remain unchanged. [Public-safe verification receipt](evidence/account-recovery-2026-09-13/verification.json).

The scope is password recovery for existing accounts. Email verification and invitation email remain subsequent work. Existing accounts retain access and are not assigned invented verification timestamps. API keys are independent credentials and remain separately revocable in Settings. Free hosting plans and visibly mocked billing are unchanged.

## User flow and API

Sign in adds **Forgot password?**, preserving the existing generic bad-credentials response. `/forgot-password` accepts an email address and shows a generic accepted state. `/api/config` exposes only `passwordRecovery: {available: boolean}`, derived from valid explicit sender configuration or a controlled injected adapter. Availability does not establish inbox delivery.

| Route | Contract |
| --- | --- |
| `POST /api/auth/password-reset/request` | `{email}`. Valid known and unknown addresses receive the same **202** response when the service can accept requests: `{accepted:true,message:"If an account uses this email, a password reset link will be sent shortly."}`. The public path never looks up the recipient's account. No account identity, token, recipient existence, queue state or provider diagnostics are returned. Invalid email input receives fixed field guidance. Globally unconfigured sending or a full 5,000-request pending queue returns the same safe **503** for known and unknown addresses and creates no new request, token or mail item. |
| `/reset-password#token=…` | New password and confirmation, using the existing 10–128-character creation policy. The page reads the token into memory and removes the fragment from browser history. Refresh requires reopening the original email link. GET and link previews never consume a token. |
| `POST /api/auth/password-reset/complete` | `{token,newPassword}`. Valid completion returns `{ok:true}`; wrong, expired, used and stale tokens share one safe **400** response. Password-policy guidance remains specific. Completion does not automatically sign in; the user returns to normal Sign in. |

The reset URL is constructed exclusively from trusted `APP_ORIGIN`, never from a request Host header, submitted return URL or caller-selected recipient. Production and remote origins require HTTPS. Token-bearing links use a no-referrer policy. Tokens must not enter browser storage, analytics, API URLs or logs.

Requesting a reset does not change the password, sign anyone out, lock an account or invalidate an existing unexpired link. Origin/fetch-site checks and shared IP protection apply. A 60-second cooldown and five grants per one-hour window use database time and HMAC-protected address identifiers, including for unknown addresses. Address-suppressed requests retain the same generic 202 response while the service has capacity; the global cap is checked first and returns the same 503 independently of address or account existence.

Every admitted address enters `account_recovery_requests` as an encrypted payload, without querying `users` in the public request transaction. A global advisory lock makes the 5,000-pending-request check and insertion atomic. A worker later resolves the address, discards unknown/expired/invalid requests, and creates a token, encrypted email and bounded security event together for an eligible account. Processing removes the request in the same transaction. This separates public acceptance from account resolution and actual email delivery.

Successful completion changes the password, revokes all browser sessions, invalidates other reset tokens, queues a password-changed notice and records a bounded security audit in one transaction. It preserves memberships, documents, quotas, integrations and billing. The success UI must describe browser-session revocation accurately: existing API keys are not revoked by a password reset.

## Tokens, concurrency and delivery

New recovery tokens contain 32 random bytes and are purpose-bound and single-use. The 30-minute expiry starts when the public request is recorded using database time; asynchronously created tokens and their emails inherit that original expiry, so queue delay and retries never restart the clock. Verification records store only a SHA-256 digest. Request addresses and link-bearing mail payloads use the existing shared AES-GCM secret helper; plaintext addresses/tokens are not persisted in those payload records. Issued tokens also bind to a digest of the current password hash.

The nullable `users.password_changed_at` records subsequent credential changes without backfilling existing accounts. Under the user lock, asynchronous resolution discards a request created at or before the latest password change. This prevents an old queued request from issuing a fresh token after a reset or Settings password change. Already-issued tokens are invalidated atomically with either password change.

The user row is the shared serialization lock for issuance, reset completion and authenticated password changes. Login must recheck the password hash under that lock before creating a session: a credential check performed before a reset cannot create a usable session afterward. Authenticated password changes also recheck the current session and credential under the lock. Concurrent reset completion has one winner; no database lock is held during a provider request.

The real Resend sender sits behind an injectable adapter. Controlled acceptance captures owned fixture deliveries without external requests; there is no public or development endpoint exposing reset links or account existence. Email contains plain text and no document or workspace content. Requests, responses and deadlines are bounded, provider failures become fixed private codes, and retries retain a stable outbox idempotency key after uncertain acknowledgements.

Mail delivery uses a durable leased queue with finite retries, restart recovery and fencing against late workers. A reset email's retry window ends with its token lifetime; retry never extends expiry. Token/credential validity is checked before sending, and credential changes cancel pending or sending reset rows. An already-started provider request cannot be recalled, but its token is invalidated and a late acknowledgement cannot reactivate it. Local and hosted workers give this queue independent progress within their existing lifetime/budget controls, so extraction work cannot starve recovery. There are no detached best-effort email calls.

Bounded cleanup removes expired or invalid tokens and clears encrypted link payloads after expiry, consumption, supersession or terminal failure. Retained diagnostics contain only bounded identifiers, counts, times and fixed codes. Provider acceptance of a send request is distinct from actual inbox delivery, and unauthenticated callers never receive recipient-specific delivery status.

## Configuration and release boundaries

[The environment example](../.env.example) documents a separate disabled-by-default sending configuration:

| Setting | Meaning |
| --- | --- |
| `FOLIO_AUTH_EMAIL_ENABLED` | Explicit opt-in; the example is `false`. |
| `FOLIO_AUTH_EMAIL_FROM` | A sender authorized for a verified sending domain. |
| `FOLIO_AUTH_EMAIL_API_KEY` | A dedicated server-only Resend sending key, separate from receiving credentials. |
| `APP_ORIGIN` | Trusted application origin used to construct links; HTTPS for production/remote operation. |

No prepared receiving credentials are loaded or reused by this increment. Empty or invalid sending configuration keeps recovery unavailable. A configured adapter or successful controlled test must not be described as a live sending integration.

Before live acceptance, establish the actual authorized sender/domain and deployment origin. Disable provider click tracking for authentication messages and verify that the delivered link is not rewritten through a tracking service; this is a provider/domain configuration recommendation, not a claim that the application currently enforces that setting. Preserve a redacted actual-delivery receipt and verify the delivered link, password change and subsequent sign-in. Never publish reset links, recipient identities, API keys or mail payloads as evidence.

Migration [028](../migrations/028_account_recovery.sql) adds nullable `users.password_changed_at` and five backend-only tables:

| Table | Purpose |
| --- | --- |
| `account_recovery_requests` | Bounded pending address resolution with encrypted payloads and request-time expiry. |
| `account_recovery_tokens` | Purpose-bound token hashes, credential digests and expiry. |
| `account_email_outbox` | Encrypted mail payloads, leases, attempts and bounded delivery outcomes. |
| `account_recovery_limits` | HMAC-address cooldown and hourly-window accounting. |
| `account_security_events` | Bounded user/action/count/time security history without recipient or token payloads. |

All five tables use forced RLS and revoke PUBLIC/tenant access. The hosted wrapper must preserve those revocations after broad tenant grants and supply its backend policy. Migration 028 is local only; preparing or applying it locally does not apply it to the hosted schema. Hosted **021–028**, matching runtime release and real authentication-email delivery require their separately recorded authorization and evidence. No hosted migration, provider request, plan change or deployment is established by this record.

## Recorded local acceptance

Password recovery passed **472/472 serial tests** in **123.381374167 seconds**, with zero failures, skips or cancellations; **20 focused cases** in **2.916794166 seconds**; and **12/12 controlled browser groups** on **Node 24.13.0**. Final build/package/compiled-runtime checks passed on **229 unchanged source files**, fingerprint **`f8cbd686c74f4a465f6d70e7e58194d8e6f5ad2c13801f93da5e757c4601ef9b`**.

| Final phase | Result | UTC interval |
| --- | --- | --- |
| Serial suite | **472/472 passed**, **123.381374167 seconds**; zero failures/skips/cancellations | **21:43:31.385396–21:45:34.842765** |
| Build | **Passed**, **1.753654458 seconds** | **21:43:32.559189–21:43:34.312861** |
| Package | **Passed**, **5.216898417 seconds** | **21:44:31.950832–21:44:37.167778** |
| Compiled runtime | **Passed**, **4.7498365 seconds** | **21:45:44.626198–21:45:49.376081** |

The compiled runtime check covered six ordinary decoders, PDF splitting, API startup, the preview invitation guard and privacy headers. The suite's **123.456283417-second** wrapper duration is distinct from its test-run duration above. Exact-head CI remains separately recorded by the review request.

### Controlled browser acceptance

The final run at **2026-09-13T21:42:26.933Z–21:42:31.187Z** passed **12/12 grouped checks** at desktop **1440×1000** and mobile **390×844**. Eleven screenshots were captured, with four reviewed directly. There were zero page errors, external requests, extraction calls or suggestion calls. A controlled mail adapter recorded **12 attempts and 11 accepted captures**, including one deliberate temporary failure; these are synthetic adapter acknowledgements, not inbox-delivery receipts, and no real email was sent. All eight owned test accounts and their fixtures were cleaned up.

The flow covers keyboard navigation from Sign in, generic unknown-address acceptance without mail, encrypted asynchronous known-address resolution, stable retry idempotency, token-fragment removal, friendly password confirmation, mobile double-submit protection, explicit return to normal sign-in, old-password rejection and new-password success. It also checks used/expired/missing links, reload/back, unavailable sending with an already-issued valid link, a second same-tab link fencing an old committed response, and a lost accepted completion recovered by signing in with the new password without blind replay.

Two sessions were revoked while the account's workspace/membership, stored text document, usage entry and API key remained intact. Browser success is separate from inbox delivery. The browser used an owned non-throttling limiter; actual rate-limit behavior is covered by Node tests. Four earlier harness-only failures remain preserved: an accessible-label mismatch, a serialized document shadowing the browser document, and two route-readiness assumptions. Those attempts prompted no application UI source fix and are not counted as successful runs.

Reviewed redacted screenshots: [desktop recovery form](evidence/account-recovery-2026-09-13/desktop-recovery-form.png), [old password rejected](evidence/account-recovery-2026-09-13/mobile-old-password-rejected.png), [password changed](evidence/account-recovery-2026-09-13/mobile-password-changed.png) and [uncertain completion](evidence/account-recovery-2026-09-13/mobile-uncertain-completion.png). Email addresses are masked.

### Source and historical checkpoints

The earlier **471/471** aggregate passed in **124.33385275 seconds** at **21:28:49–21:30:53 UTC** on source `75942c388643da06ee195271b2880af5a856e0b8442a400a64f84eb047d70ab0`. Review then found that cleanup could remove an expired address-limit row between insert-conflict handling and its locked read, causing an unexpected 500. A bounded retry and deterministic regression fix that race. The earlier pass/build/package/runtime records remain historical and do not verify the changed source.

## Coverage and remaining acceptance

- **Focused Node 24 coverage (20 passing cases):** uniform known/unknown responses and throttles, including a full 5,000-request queue's uniform 503; disabled sending; encrypted asynchronous request resolution; request-time expiry; old queued requests invalidated by password changes; hashed tokens/encrypted delivery material; purpose/expiry/replay; concurrent consumption and atomic rollback; stale-login/password-change fencing; cross-account isolation; old-session rejection; API-key independence; unchanged workspace/document state.
- **Durable mail:** leased retries, restart and uncertain-acknowledgement recovery, expiry and secret cleanup, cancellation after credential changes, fixed diagnostics and no raw-token/provider-error leakage. Verify backend-only migration grants and wrapper ordering.
- **Browser coverage (12 passing groups):** Sign in → forgot password → generic response → controlled captured email link → new password/confirmation → success → old credentials rejected/new credentials accepted. Include expired/used/missing links, back/reload/multiple tabs, loading/double-submit, unavailable sending, desktop/mobile, keyboard/focus/layout and console checks.
- **Release candidate:** final Node 24 aggregate/build/package/compiled-runtime and controlled browser checks passed on the same source. Known-secret comparison found zero matches across 701 tracked/nonignored files. All 47 original capability identities and acceptance criteria match the saved baseline exactly. Diff review and exact-head CI remain separate evidence layers.
- **External proof:** verified real sender/domain, actual inbox receipt, unrewritten link and completed hosted reset/sign-in. Controlled queue/adapter success and provider send acknowledgement alone do not close this gate.

Email verification and invitation delivery remain open after password recovery. This increment must not be presented as complete production authentication or full reference-product parity.
