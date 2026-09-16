# Web Phase 1 API

This service is separate from the existing local connector. It does not call NetEase Cloud Music and does not read `connector/.state`.

## Local start

1. Copy `.env.example` to a local `.env` file and fill `DATABASE_URL` after creating PostgreSQL.
2. Run `npm install` once.
3. Run `npm run migrate`.
4. Run `npm run dev`.

`GET /health`, registration, login, and `/phase1/items` all require a real PostgreSQL database. A successful health response includes `"database":"connected"`; it never reports a simulated database connection.

## Existing-page test entry

Start this API locally, then open the existing KTV page and choose **设置 → 网站账号与云端测试**. The small test panel is deliberately separate from the local KTV library and the NetEase connector. Its default API address is `http://127.0.0.1:8787` for local development.

Before deploying the page, set `window.KTV_WEB_API_URL` to the public HTTPS API address in the page configuration. Do not use the local default in production.

For production, set `HOST=0.0.0.0`, put this service behind HTTPS, use a production `APP_ORIGIN`, keep `WEB_COOKIE_SECURE=true`, and store `DATABASE_URL` only in the host's secret manager.
