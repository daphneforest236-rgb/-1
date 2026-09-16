# 本机数据连接器

该服务只监听 `127.0.0.1:16368`，用于在本机网页与网易云 API 之间建立连接。

登录凭证仅保存在 `connector/.state/cookie.txt`，不会由任何 HTTP 接口返回，也不会写入网页的本地存储。

已提供接口：

- `GET /health`、`GET /status`、`POST /settings`
- `POST /auth/qr`、`GET /auth/status`
- `GET/POST/DELETE /sources`
- `POST /sync`
- `GET /queue`、`POST /queue/items/:id`、`POST /queue/cancel`、`POST /queue/commit`

`POST /queue/items/:id` 的请求体为 `{ "action": "中文" }`。`action` 可选：
`中文`、`日文`、`英文`、`韩文`、`粤语`、`法语`、`西班牙语`、`德语`、`俄语`、`泰语`、`纯音乐`、`伴奏`、`忽略`。

`POST /settings` 用于保存本机自动同步设置，例如 `{ "autoSync": true, "syncPeriodHours": 12 }`。

`POST /sync` 会先比较连接器 `records` 和网页传入的本地曲库 ID：
`{ "localSongIds": ["netease-1336856864"] }`。返回值会区分 `scanned`、`added`、`updated`、`existing`、`pending`，并用 `updates` 返回已存在歌曲的元数据更新。用户确认过的判断会写入 `decisions`，下次同步同一首歌会直接套用。

## 启动

这个项目有两个本机服务，缺少其中任何一个都不能做真实扫码或同步：

1. 在 `connector` 目录运行 `npm run api`，启动兼容网易云接口的本机 API（默认 `127.0.0.1:3000`）。首次运行会由 npm 下载该公开依赖。
2. 另开一个终端，在同一目录运行 `npm run connector`，启动网页连接器（`127.0.0.1:16368`）。

网页中的二维码、登录状态和歌单内容全部通过这两个本机服务取得。项目内的 `vendor/` 包含歌单解析代码；连接器不再依赖 `C:/Users/Lenovo/Desktop/...` 的绝对路径。
