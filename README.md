# Ledgerly

**A self-hosted earnings & expense tracker for side hustles and small businesses.**

Track what each of your businesses earns and spends, claim mileage at NZ Inland Revenue kilometre rates, split shared bills, and get a profit & loss report at tax time. Run it on your own server, NAS or Raspberry Pi. Everyone on the server gets their own private account.

- **Several businesses per account.** Each has its own expense categories, and you can see them separately or combined.
- **Four kinds of transaction:** earnings, expenses, mileage (IRD Tier 1 / Tier 2 kilometre rates, tracked per vehicle and income year) and shared bills (only the work percentage is claimed).
- **Dashboard, transactions, P&L reports**, CSV export, printing, dark mode, and a layout that works on phones.
- **Multi-user, with separate data.** Every record belongs to one account. The database enforces this, not just the app code.
- **Easy to self-host.** One small Docker image, one SQLite file, no external database, no npm dependencies.

---

## Quick start (Docker)

```bash
docker run -d --name ledgerly \
  -p 8080:8080 \
  -v ledgerly-data:/data \
  --restart unless-stopped \
  ghcr.io/matthewoncloud/ledgerly:latest
```

Open <http://localhost:8080> and **create the first account. It becomes the administrator.** After that, sign-ups are closed: the admin can add people in **Settings → Server administration** or open sign-ups there.

> Replace `matthewoncloud` with the GitHub user or organisation that publishes the image (see [Publishing the image](#publishing-the-image)).

### Docker Compose

```yaml
services:
  ledgerly:
    image: ghcr.io/matthewoncloud/ledgerly:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      TRUST_PROXY: "false"   # "true" behind a reverse proxy
    volumes:
      - ledgerly-data:/data

volumes:
  ledgerly-data:
```

A ready-made [`docker-compose.yml`](docker-compose.yml) is included. To build from source instead of pulling, run `docker compose build` or `docker build -t ledgerly .`.

> **Using a bind mount** (e.g. `./data:/data`) instead of a named volume? The container runs as UID 1000, so give it the folder first: `sudo chown -R 1000:1000 ./data`.

## Configuration

All settings are environment variables. Everything is optional.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind to. |
| `DATA_DIR` | `/data` (Docker), `./data` | Folder for the SQLite database. |
| `DATABASE_PATH` | `$DATA_DIR/ledgerly.db` | Full path to the database file, if you want to set it directly. |
| `ALLOW_REGISTRATION` | *(unset)* | Unset: admins open or close sign-ups in Settings. `true` or `false` forces it and locks the setting. The first account can always be created. |
| `SESSION_DAYS` | `30` | How long a sign-in lasts. It is extended while you keep using the app. |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy so `X-Forwarded-For` and `X-Forwarded-Proto` are trusted (for rate limiting and secure cookies). |
| `COOKIE_SECURE` | `auto` | `auto` marks the session cookie `Secure` when the request came over HTTPS. Set `true` to always do it, or `false` to never. |
| `LOG_REQUESTS` | `false` | Log one line per request. |

## Running behind a reverse proxy (HTTPS)

Put Ledgerly behind a proxy that handles TLS and set `TRUST_PROXY=true`.

**Caddy**

```
ledger.example.com {
    reverse_proxy ledgerly:8080
}
```

**nginx**

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 25m;   # large backups can be restored
}
```

Traefik works with the usual `loadbalancer.server.port=8080` label.

## Users & data separation

- **First account = administrator.** Admins can add users, reset their passwords, promote or demote admins, delete users, and open or close sign-ups. **Admins cannot see anyone else's businesses or transactions.**
- Every business, vehicle, transaction and preference is stored against its owner's user ID. All tables use composite keys `(user_id, id)`, and the foreign keys include `user_id`, so a row can't point at another user's data even if a query had a bug. The test suite checks this (`test/api.test.js`).
- Each user can change their password (this signs out their other devices) or delete their account and all of its data from **Settings → Account**.

## Backups

All data is in one SQLite file, `ledgerly.db`, inside the data volume.

- **Per user:** **Settings → Your data → Back up** downloads a JSON file that **Restore** can load again. This also works across servers.
- **Whole server:** back up the volume. For a consistent copy while the app is running, use SQLite's online backup:

  ```bash
  docker exec ledgerly node -e "new (require('node:sqlite').DatabaseSync)('/data/ledgerly.db').exec(\"VACUUM INTO '/data/backup.db'\")"
  docker cp ledgerly:/data/backup.db ./ledgerly-backup.db
  ```

  You can also stop the container and copy the volume.

### Moving from the single-file version

If you used the original single `index.html` version (data kept in your browser):

1. Open the old file and go to **Settings → Back up** to download your JSON backup.
2. Sign in to your Ledgerly server and go to **Settings → Restore**, then pick that file.

## Development

You need Node.js **22.13 or newer**. Nothing has to be installed: the app uses only Node's built-in modules, including `node:sqlite`.

```bash
npm start          # http://localhost:8080, data in ./data
npm run dev        # restarts when server files change
npm test           # API + data-separation tests (node:test)
```

### Project layout

```
server/
  index.js          entry point (config, start/stop)
  app.js            HTTP server: routing, sessions, CSRF checks, static files
  config.js         environment variables
  db.js             SQLite connection and migrations
  auth.js           password hashing (scrypt), sessions, rate limiting
  ledger.js         validation and storage of businesses, vehicles, transactions, settings
  routes/           auth, ledger and admin API endpoints
public/
  index.html        the app shell
  login.html        sign-in / sign-up page
  assets/           app.js, login.js, app.css, theme.js, favicon
test/               API tests
```

### How it fits together

- The **frontend** is plain HTML, CSS and JavaScript with no build step. On load it fetches the signed-in user's data (`GET /api/data`) and does all the maths (totals, IRD kilometre tiers, reports) in the browser. Each change shows on screen straight away and is sent to the API in the background, one request at a time and in order. If a save fails, the app reloads what the server actually has.
- The **backend** is a small Node.js server with a JSON API, using SQLite in WAL mode. Passwords are hashed with scrypt. Sessions are random tokens stored hashed in the database and sent as an `HttpOnly`, `SameSite=Lax` cookie. Writes must be JSON requests and are refused if the browser labels them cross-site (CSRF protection). Responses include a strict Content-Security-Policy.

### API overview

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Health check (used by Docker) |
| `GET /api/auth/config` | Whether setup or sign-ups are available |
| `POST /api/auth/register` · `login` · `logout` | Create account, sign in, sign out |
| `GET /api/auth/me` | Current user |
| `PUT /api/auth/password` | Change password |
| `POST /api/auth/delete-account` | Delete own account and data |
| `GET /api/data` · `PUT /api/data` | Load everything · replace everything (restore) |
| `GET /api/export` | Download a JSON backup |
| `PUT /api/settings` | Save preferences |
| `POST/PUT/DELETE /api/businesses[/:id]` | Businesses and their categories |
| `POST/PUT/DELETE /api/vehicles[/:id]` | Vehicles |
| `POST/PUT/DELETE /api/entries[/:id]`, `POST /api/entries/bulk`, `DELETE /api/entries` | Transactions |
| `GET/POST/PUT/DELETE /api/admin/users[/:id]`, `GET/PUT /api/admin/settings` | Administration (admins only) |

### Database migrations

Schema changes go in the `MIGRATIONS` array in `server/db.js`. Add a new entry to the end and never edit one that has already shipped. They run automatically at startup, and the schema version is tracked with `PRAGMA user_version`.

## Publishing the image

[`.github/workflows/docker.yml`](.github/workflows/docker.yml) builds a multi-architecture image (`linux/amd64` and `linux/arm64`) and pushes it to GitHub Container Registry as `ghcr.io/<owner>/<repo>`:

- every push to `main` → `:main` and `:latest`
- tags like `v1.2.0` → `:1.2.0`, `:1.2` and `:1`

After the first run, open the package on GitHub (**your profile → Packages → ledgerly → Package settings**) and set its visibility to **Public** so anyone can pull it. [`ci.yml`](.github/workflows/ci.yml) runs the tests and a Docker smoke test on every push and pull request.

## Notes

Kilometre rates follow New Zealand Inland Revenue (IRD) rules. The tax put-aside figure is a savings guide only, not tax advice.

## License

[MIT](LICENSE)
