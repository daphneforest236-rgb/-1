# Web API

This service is separate from the existing local connector. It does not call NetEase Cloud Music and does not read `connector/.state`.

## Local start

1. Copy `.env.example` to a local `.env` file and fill `DATABASE_URL` after creating PostgreSQL.
2. Run `npm install` once.
3. Run `npm run migrate`.
4. Run `npm run dev`.

`GET /health`, registration, login, and cloud-library endpoints all require a real PostgreSQL database. A successful health response includes `"database":"connected"`; it never reports a simulated database connection.

## Phase 2 cloud library

The API exposes a website-account-scoped library:

- `GET /library/tracks`
- `POST /library/tracks`
- `PATCH /library/tracks/:id`
- `DELETE /library/tracks/:id`
- `POST /library/import`

Every route derives the owner from the server-side session. There is deliberately no client-provided `user_id` parameter. A local playlist is never imported automatically: the signed-in user must choose the one-time import button.

## Existing-page test entry

Start this API locally, then open **http://127.0.0.1:8787/**. A signed-in account reads only its own PostgreSQL library. Choose **设置 → 云端曲库** to add, delete, or explicitly import local candidate songs. Do not use `file:///.../dist/index.html` for account testing: it is a different browser site and InPrivate blocks its cross-site session cookie.

Before deploying the page, set `window.KTV_WEB_API_URL` to the public HTTPS API address in the page configuration. Do not use the local default in production.

For production, set `HOST=0.0.0.0`, put this service behind HTTPS, use a production `APP_ORIGIN`, keep `WEB_COOKIE_SECURE=true`, and store `DATABASE_URL` only in the host's secret manager.
