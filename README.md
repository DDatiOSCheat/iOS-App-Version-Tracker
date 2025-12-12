# iOS App Version Tracker

A Node.js application that tracks iOS app version updates from the App Store and notifies via Discord webhook.
It fetches both the latest app metadata via iTunes API and full version history by scraping the App Store page.

---

## Features

* Fetch the latest app info using [iTunes Lookup API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html).
* Scrape the full version history from the App Store page (supports multiple App Store UI structures).
* Persist version history using [Vercel KV](https://vercel.com/docs/kv).
* Send notifications to Discord webhook when a new version is detected.
* Provides a simple web UI and JSON API for viewing version history.
* Cron job support to check for updates automatically.

---

## Requirements

* Node.js v18+
* Vercel KV for storage (or compatible KV store)
* Discord webhook URL (optional, for notifications)

---

## Installation

1. Clone the repository:

```bash
git clone <repo-url>
cd <repo-folder>
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the project root:

```env
PORT=3000
APP_ID=1190307500          # Default app to track
COUNTRIES=vn,us            # Comma-separated list of countries
DISCORD_WEBHOOK=<your-webhook-url>
CRON_SCHEDULE=*/10 * * * * # Every 10 minutes (default)
ENABLE_CRON=true
TIMEZONE=Asia/Bangkok
```

---

## Usage

### Start the server

```bash
npm start
```

The server will run at `http://localhost:3000` by default.

---

### Web UI

Open your browser and visit:

```
http://localhost:3000/?appId=<APP_ID>&country=<COUNTRY_CODE>
```

Example:

```
http://localhost:3000/?appId=1190307500&country=vn
```

The UI shows:

* Latest app metadata (version, release notes)
* Full version history stored in Vercel KV

---

### API Endpoints

* **GET `/api/changelog?appId=<appId>&country=<country>`**
  Returns JSON changelog (saved or live fetch if not present).

* **POST `/api/refresh`**
  Force fetch and save latest version info.

```json
{
  "appId": "1190307500",
  "country": "vn",
  "lang": "vi"
}
```

---

### Cron Job

Automatically checks for new versions based on `CRON_SCHEDULE` in `.env`.
If a new version is detected, it:

1. Saves it to Vercel KV
2. Sends a Discord webhook notification

Default schedule: every 10 minutes (`*/10 * * * *`).

---

## Environment Variables

| Variable          | Description                                    | Default      |
| ----------------- | ---------------------------------------------- | ------------ |
| `PORT`            | Port for Express server                        | 3000         |
| `APP_ID`          | Default App Store app ID to track              | 1190307500   |
| `COUNTRIES`       | Comma-separated list of country codes to track | vn,us        |
| `DISCORD_WEBHOOK` | Discord webhook URL for notifications          | -            |
| `CRON_SCHEDULE`   | Cron schedule for automatic checks             | */10 * * * * |
| `ENABLE_CRON`     | Enable or disable cron job                     | true         |
| `TIMEZONE`        | Timezone for cron job                          | Asia/Bangkok |

---

## Dependencies

* [express](https://www.npmjs.com/package/express)
* [axios](https://www.npmjs.com/package/axios)
* [cheerio](https://www.npmjs.com/package/cheerio)
* [node-cron](https://www.npmjs.com/package/node-cron)
* [dotenv](https://www.npmjs.com/package/dotenv)
* [@vercel/kv](https://www.npmjs.com/package/@vercel/kv)
* [ejs](https://www.npmjs.com/package/ejs)

---

## License

MIT License

---

## Notes

* Supports multiple App Store UI structures for version scraping.
* Automatically merges new versions with existing history in Vercel KV.
* Discord notifications are optional but recommended for real-time alerts.
