# Web Phase 1 API

This service is separate from the existing local connector. It does not call NetEase Cloud Music and does not read `connector/.state`.

## Local start

1. Copy `.env.example` to a local `.env` file and fill `DATABASE_URL` after creating PostgreSQL.
2. Run `npm install` once.
3. Run `npm run migrate`.
4. Run `npm run dev`.

`GET /health` works without a database. Registration, login, and `/phase1/items` require a real PostgreSQL database.

For production, set `HOST=0.0.0.0`, put this service behind HTTPS, use a production `APP_ORIGIN`, keep `WEB_COOKIE_SECURE=true`, and store `DATABASE_URL` only in the host's secret manager.
