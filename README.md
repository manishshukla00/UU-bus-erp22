# UU Bus ERP · United University Bus Verification

A fast, proxy-resistant **QR boarding and verification system** for United University's buses.
It brings the Google Apps Script verification system (Students / Buses / Incharges sheets) onto a
real web stack: a **React 19 + Tailwind CSS** front end and a **Node.js (Express) API** with a
SQLite / Turso database.

* Every bus has **its own portal** (`/bus/UU-10`), **its own QR code** and **its own incharge login**.
* The incharge starts the **morning** (to college) or **evening** (from college) trip and shows the QR.
* A student scans it with their **own phone**, types their **UUID or enrollment number** and taps
  **Verify Student**. The card shows **BUS NO.**, photo, name, course, route, enrollment number and
  **✓ VERIFIED**, the same card as the Apps Script page.
* The bus portal and the admin dashboard update **live**: the admin sees **today's verified students
  with the count**, per bus "verified of N active students", and **duplicate scans** (students who
  scanned again after being verified).
* The whole Apps Script **Excel workbook imports in one step** (Admin → Import Excel).

This is not an attendance register: it records who was verified on which bus trip.

---

## Quick start (local / same Wi-Fi)

Requirements: **Node.js 22.13 or newer** (uses the built-in SQLite, no native modules).

```bash
npm install
npm run build         # builds the React app into dist/
npm run seed:demo     # optional: a demo fleet with demo students to try things out
npm start
```

Then open <http://localhost:3000>.

* First run creates the **admin** account and prints its one-time password in the console
  (also saved to `data/initial-admin.txt`; delete that file after signing in). You are asked to
  set a new password at first sign-in.
* Import your data: **Admin → Import Excel**, choose the *United University Bus Database* workbook.
  It creates the buses, one incharge account per bus (Login ID = the sheet's `InchargeID`, e.g.
  `IC-UU10`, with a generated password shown once) and every student.
* The console also prints the **Network** address, e.g. `http://192.168.1.10:3000`. That is what
  the QR codes encode, so student phones must be able to reach it (same Wi-Fi). Change it any
  time from **Admin → Settings**, or set `BASE_URL` in `.env`.

While developing the front end, run the API and the Vite dev server side by side:

```bash
npm run dev           # API on :3000, restarts on changes
npm run dev:web       # React app on :5173 with hot reload (sends /api to :3000)
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm start` | run the server (serves the built app from `dist/` and the API) |
| `npm run build` | build the React app into `dist/` |
| `npm run dev` / `npm run dev:web` | API with auto-restart / React app with hot reload |
| `npm run seed:buses` | create a demo 19-bus fleet: buses, stops, one incharge account per bus |
| `npm run seed:demo` | the demo fleet plus demo students (about 6 per bus) |
| `npm run reset-admin` | reset the admin password if it is lost |
| `npm run backup` | consistent copy of the database into `data/backups/` |
| `npm run test:security` | end-to-end test of every security and verification rule against a running server |
| `npm run serve:function` | run the serverless function locally on port 3001 |

---

## Bus portals

| What | Where | Who can open it |
| --- | --- | --- |
| Bus portal (start trip, QR, live count, roster, manual check-in, end trip) | `/bus/<number>` | that bus's incharge or the super admin; operations admins can watch it (no QR, no actions) |
| Portal picker (every bus with live status) | `/incharge` | super and operations admins, incharges with no assigned bus |
| Student verification (what the QR encodes) | `/checkin/<number>?t=<token>` | any phone that scanned that bus's QR |
| Transport console | `/admin` | super admin (everything), operations admin (read-only) |

* An incharge signs in and lands straight on their own bus portal. Opening another bus's portal
  sends them back to theirs; the API refuses it too (`WRONG_BUS_PORTAL`).
* Each bus's QR is unique to that bus: a UU-12 token presented on the UU-10 link is rejected.
* Buses, routes and accounts can be edited any time under **Admin → Buses & routes** and
  **Admin → Staff**; the portal address follows the bus number.

---

## How it works

```
 Bus screen (incharge, signed in)        Student phone (no login)            Admin console
 ┌──────────────────────────────┐        ┌──────────────────────────┐        ┌──────────────────────┐
 │ Start trip → bus QR          │ scan   │ /checkin/UU-10?t=<token> │        │ today: verified of N │
 │ token signed (HMAC)          │ ─────► │ token → private session  │        │ per bus, duplicates, │
 │ live count + roster          │        │ UUID / enrollment no.    │        │ today's verified     │
 │ "just verified" photo card   │ ◄───── │ → BUS NO. card, VERIFIED │ ─────► │ students, CSV, trips │
 └──────────────────────────────┘ event  └──────────────────────────┘ event  └──────────────────────┘
```

1. **Incharge** signs in, lands on their bus portal, picks **Morning** (to college) or
   **Evening** (from college) and presses *Start trip*.
2. The portal shows the bus's QR. Three modes (Admin → Settings → QR validity):
   * **Per trip** (default): each trip gets its own QR, valid for 2 hours from the trip start
     (the hours can be changed). After that the portal shows "QR expired"; **New QR code** gives
     another 2 hours. A photo of it is useless on any other trip.
   * **Whole day**: one QR per bus per calendar day, India time. It works for whichever
     trip the bus is running, can be printed, and **New QR code** on the portal cancels it.
   * **Rotating**: a new QR every 20 seconds, bound to the trip; only the live screen works.
3. **Student** scans with the normal camera app. The server checks the token and opens a
   5-minute verification session bound to that phone.
4. The student types their **UUID or enrollment number** and taps **Verify Student**. One request
   does the lookup and the atomic check-in. Everything on the card comes from the database.
5. The verification appears on the bus portal (with the student's photo, so the incharge can
   compare faces) and on every admin dashboard: instantly over Server-Sent Events on a single
   server, or within a few seconds by polling on Netlify / Vercel.
6. Scanning again after being verified shows the card marked **ALREADY VERIFIED** and counts as a
   **duplicate**. **End trip** closes the trip; the QR and all pending sessions stop working.

---

## Anti-proxy design (why nobody can "mark" for a friend)

| Threat | Defence |
| --- | --- |
| Screenshot / forwarded QR | **Rotating mode:** token changes every 20 s and is accepted for at most 40 s; only the live screen works. **Whole-day mode:** a photo of the QR works until midnight, so an absent student *can* check in if someone forwards it. The incharge sees every name live and can press **New QR code** to cancel a leaked QR; switch to rotating mode for the strongest protection. Tampered, old-day or future tokens are rejected in both modes. |
| Friend scans and types your ID | **One phone, one student.** The phone is identified by a signed HttpOnly cookie mirrored in localStorage; the first student who boards with a phone owns it. Another student on that phone is refused. A phone can board only one student per trip. |
| Student uses many phones | Max 2 phones per student per 30 days; after that admin must reset devices (Students → history). First boarding from a new phone is flagged **new_device**. |
| Boarding the wrong bus | Refused: the UUID / enrollment number must belong to a student registered on that bus, otherwise the student sees **Student not found for this bus**. Manual check-ins and the bus admin's student search are limited to the bus's own students too. |
| Guessing IDs | 6 attempts per scan, then a fresh scan is needed; the QR session lasts 5 minutes and is tied to the phone. Generous per-network rate limits (campus NAT friendly). A guessed ID still runs into the one-phone-one-student rule, and the incharge sees each verified student's name and photo live. |
| Double check-in | Database unique constraint per (trip, student) and per (trip, phone). A repeat scan shows **ALREADY VERIFIED** and is counted as a duplicate. |
| Staff account attacks | scrypt password hashing, constant-time checks, 5-strike 15-minute lockout, temporary passwords that must be changed, session ids stored hashed, sessions expire after 12 h idle / 7 days max. |
| CSRF / cross-site | SameSite cookies + per-session CSRF token + Origin check on every state-changing call. |
| XSS / injection | Strict Content-Security-Policy (no inline scripts or styles, same-origin only), all output escaped, all SQL parameterised, input validated with zod. |
| Tampering by staff | Manual check-ins are flagged **manual** with the staff name and reason; every admin action is in the audit log. |

What it cannot do: it cannot see whether the phone is physically on the bus. For that, the
incharge is in the loop: each verified student appears live with their photo, flagged entries
stand out, and the "not yet" list shows who is still missing.

---

## Configuration (`.env`)

Copy `.env.example` to `.env`. Everything is optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | where to listen |
| `BASE_URL` | auto (LAN IP) | public address encoded in QR codes, e.g. `https://bus.college.edu` |
| `NODE_ENV` | `development` | set `production` when deployed |
| `TRUST_PROXY` | off | set `1` behind nginx / Cloudflare so real IPs are logged and limited |
| `SESSION_SECRET` | generated once into `data/secret.key` | signing key for sessions, device ids and QR tokens |
| `SESSION_HOURS` | `12` | staff session idle lifetime |
| `QR_MODE` | `trip` | QR mode until an admin changes it in Settings: `trip` (one QR per trip, valid `QR_TRIP_HOURS`), `day` (one QR per bus per day) or `rotating` |
| `QR_TRIP_HOURS` | `2` | `trip` mode: hours a trip's QR stays valid (0.5–12; also in Settings) |
| `QR_ROTATE_SECONDS` | `20` | rotating mode: QR refresh interval (minimum 10) |
| `QR_GRACE_SLOTS` | `1` | how many previous QR windows are still valid |
| `CHECKIN_MINUTES` | `5` | time a student has to finish after scanning |
| `MAX_DEVICES_PER_STUDENT` | `2` | phones a student may use in 30 days |
| `COOKIE_SECURE` | auto | force the `Secure` cookie flag (auto on when `BASE_URL` is https, always on Vercel) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | unset (local SQLite file) | use a Turso database instead of `data/bus-erp.sqlite`; required on Vercel |
| `ADMIN_PASSWORD` | unset | password for the first `admin` account (on Vercel the only way to create it without seeding) |
| `LIVE_MODE` | `sse` locally, `poll` on Vercel | how screens get live updates |
| `RATE_LIMIT_STORE` | `memory` locally, `db` on Vercel | where login / scan throttles are counted |
| `SERVERLESS` | auto on Vercel / Netlify / AWS Lambda | force serverless behaviour, e.g. for `npm run serve:function` |
| `POLL_SECONDS` | `2.5` | how often screens poll for live updates in serverless mode (1.5–30); higher = fewer function calls |

---

## Deploy on Vercel

Students board on **mobile data**, so production needs a public HTTPS address. The repo is
ready for Vercel: `npm run build` builds the React app into `dist/`, which Vercel's CDN serves;
`api/index.js` runs the API as one serverless function, and functions are pinned to Mumbai (`bom1`) in `vercel.json`.

Serverless functions have no disk that survives between requests, so on Vercel the data lives
in **Turso**, a hosted database that speaks the same SQLite dialect (nothing in the app changes).
Live updates switch automatically from push to **polling every ~2.5 s**, and login / scan
throttles are shared through the database so every function instance enforces the same limits.

**1. Create the project**

1. Go to <https://vercel.com/new>, sign in with GitHub and import `manishshukla00/UU-bus-erp22`.
   The framework preset comes from `vercel.json` ("Other"); it runs `npm run build`.
2. Before the first deploy, add an environment variable `SESSION_SECRET` with a long random
   value. Generate one with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   Keep it stable: changing it signs everyone out and invalidates running QR codes.

**2. Connect a Turso database**

In the Vercel project open **Storage → Create / Browse Marketplace → Turso**, create a database
(pick the **Mumbai / ap-south-1** region, next to the functions) and connect it to the project.
That adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Then **redeploy** (Deployments → ⋯ →
Redeploy) so the function picks them up. Until both variables exist, every page shows a short
"Finish the server setup" checklist instead of failing.

**3. Create the 19 buses and accounts in Turso** (from your computer, once)

```bash
npx vercel link
npx vercel env pull .env.vercel --environment production
set -a; . ./.env.vercel; set +a; npm run seed:buses
```

`vercel env pull` writes the Turso URL and token into `.env.vercel` (git-ignored). It is
deliberately not `.env`: the app reads `.env` on every local start, so production settings
there would make your laptop write to the live database. The third line loads them only for
the seed (Git Bash / macOS / Linux syntax), which then creates the 19 buses, their stops,
`admin` and `incharge1` … `incharge19` directly in Turso.
The passwords are printed and saved to `data/turso-initial-admin.txt` and
`data/turso-incharge-accounts.txt` (separate from your local files). Instead of seeding you can
set `ADMIN_PASSWORD` on Vercel: the first request then creates `admin` with that password, and
**Admin → Import Excel** creates the buses, incharge accounts and students from the workbook.

**4. Use it**

Open `https://<your-project>.vercel.app`, sign in as `admin`, change the password, import the
students (Admin → Students → Import CSV), and give each incharge their line. QR codes use the
production domain automatically; add a custom domain under Settings → Domains and it is picked
up the same way (or set it in Admin → Settings → Public base URL).

Good to know:

* **Plan.** Vercel's free Hobby plan is meant for personal, non-commercial projects. For the
  college's official system use **Pro**. Polling means each open bus screen makes about one
  request every 2.5 s, roughly 1 million function calls a month for 19 buses boarding about an
  hour a day. Check current limits on <https://vercel.com/pricing> and <https://turso.tech/pricing>.
* **Preview deployments** get the same variables unless you scope them. Scope the Turso
  variables to **Production** if previews must not touch real data.
* **CSV imports** are limited to about 4 MB per file on Vercel (≈ 30,000 students); split
  bigger files.
* **Backups.** Turso keeps point-in-time history; `turso db export` gives a local copy.

**Try serverless mode locally first** (optional): with the Turso variables in `.env`,
`SERVERLESS=1 npm run serve:function` runs the exact Vercel function on
<http://localhost:3001>.

## Deploy on Netlify

Same idea as Vercel: `netlify/functions/server.js` runs the whole app as one function
(through `serverless-http`), the React app in `dist/` is served from Netlify's CDN (pages load
without waiting for the function), `netlify.toml` sends `/api/*` to the function, and the data lives in **Turso**. Live updates use polling and
throttles are shared through the database, exactly as on Vercel.

**1. Create a Turso database**

Sign up at <https://turso.tech> (GitHub sign-in works), create a database and create a
database token. Put the database **next to the functions**: on Netlify's free plan functions run
in US East (Ohio), so choose a US East location. On a paid plan you can move the functions to
Singapore (`region = "sin"` in `netlify.toml`, or Site configuration → Functions → Region) and
use the Turso location closest to it. Netlify has no Mumbai region. Alternatively install
Netlify's **Turso extension** (team → Extensions); the app also accepts the variable names it
injects.

**2. Create the site**

<https://app.netlify.com/start> → Import from Git → GitHub → `manishshukla00/UU-bus-erp22`.
Build settings come from `netlify.toml` (`npm run build`, publish `dist`). Before deploying, add these environment
variables (Site configuration → Environment variables):

| Variable | Value |
| --- | --- |
| `SESSION_SECRET` | long random value: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `TURSO_DATABASE_URL` | `libsql://<database>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | the database token |
| `ADMIN_PASSWORD` | password for the first `admin` login (changed at first sign-in; you can delete the variable afterwards) |
| `POLL_SECONDS` | `5` recommended on the free plan (see below) |

Deploy (or redeploy after changing variables). Until the database variables exist, every page
shows a short "Finish the server setup" checklist.

**3. Import the buses, incharges and students**

Sign in as `admin`, set a new password, open **Admin → Import Excel** and choose the
*United University Bus Database* workbook. It creates the buses, one incharge account per bus
(Login ID = `InchargeID`) and every student, and shows the new incharge passwords **once** with
Copy and Download CSV buttons. The same page works on Vercel and on a local server.

Command-line alternative (Netlify CLI):

```bash
npx netlify-cli login
npx netlify-cli sites:create --name your-site-name
npx netlify-cli env:set SESSION_SECRET "<long random value>" --secret
npx netlify-cli deploy --build --prod
```

Good to know:

* **Free plan cap.** Netlify's free plan has a fixed monthly credit allowance; when it runs out,
  the team's sites are **paused** until the next cycle. Every poll and every page or API request
  counts. With `POLL_SECONDS=5`, 19 bus screens boarding about an hour a day plus an admin
  dashboard come to roughly half a million function calls a month. Check
  <https://www.netlify.com/pricing/> and use a paid plan for the college's official system.
* **Limits.** Requests and responses are capped at 6 MB (CSV imports up to ~4 MB), and functions
  time out after 60 seconds; the app needs far less.
* **Testing the package locally:** `npx netlify-cli build` creates `.netlify/functions/server.zip`,
  the exact bundle Netlify uploads.

## Other hosting

* **A college server / VPS** – `npm start` under a process manager
  (`pm2 start npm --name bus-erp -- start`) behind nginx or Caddy with HTTPS, set
  `BASE_URL=https://your-domain`, `NODE_ENV=production`, `TRUST_PROXY=1`. Uses the local
  SQLite file with instant push updates; back up `data/` with `npm run backup`.
* **Render / Railway / Fly.io** – same as a VPS with a persistent disk mounted at `data/`, or
  point `TURSO_DATABASE_URL` at Turso and skip the disk.
* **Quick public test from a laptop** – `cloudflared tunnel --url http://localhost:3000` or
  `ngrok http 3000`, then put the https URL in **Admin → Settings → Public base URL**.

---

## Importing data

**The Excel workbook (recommended): Admin → Import Excel.** Choose the *United University Bus
Database* `.xlsx` (the Apps Script layout). It is read in the browser and previewed first; on
**Import**:

| Sheet | Columns used | Becomes |
| --- | --- | --- |
| Buses | BusNo, Route, Active | buses (portal `/bus/<BusNo>`) |
| Incharges | InchargeID, Name, BusNo, Active, Role | one incharge account per row with role INCHARGE (Login ID = InchargeID, password generated and shown once). The ADMIN row, Salt and PINHash are ignored. |
| Students | UUID, Name, PhotoURL, Route, BusNo, Course, EnrollmentNo, Active | students. `Route` is the pickup point; `Active` FALSE keeps the student but blocks verification. |

VerificationKeys / VerificationLogs are not imported (they are the old system's history).

**CSV or a single sheet: Admin → Students → Import.** Header row required, column names are
flexible (`UUID` or `id`, `EnrollmentNo`, `BusNo` or `bus`, `Route` or `stop`, `PhotoURL`, …):

```csv
UUID,Name,PhotoURL,Route,BusNo,Course,EnrollmentNo,Active
UU253500002,Akanksha Yadav,,01 Trivenipuram Crossing Jhunsi,UU-10,AGRI-BSc-AG (Honors)-2025-2-AG,UU253500002,TRUE
```

* Unknown buses and routes are created automatically. Existing UUIDs are updated, not duplicated.
* `PhotoURL` must be a public `https://` link to an image; without one the card shows a placeholder.
* **Export** on the Students page gives the same columns back, so the file round-trips.

---

## Roles

* **Super admin** (role `admin`): everything: students, buses and routes, Excel import, staff
  accounts and their passwords, trips, flags, audit log, settings, device resets. Can run any bus portal.
* **Operations admin** (role `operator`): sees the dashboard, students, buses, trips and flags,
  and can watch any bus live, but cannot change anything.
* **Bus incharge** (role `incharge`, one per bus): signs in straight into their own bus portal,
  starts and ends that bus's trips, shows the QR, sees every student of the bus with who has
  verified, and can mark a student manually. Cannot open another bus, and **cannot change their
  own password**: only the super admin sets it (Staff → key) and can look it up later (Staff → eye;
  stored encrypted, every view is in the audit log). Super admin passwords are never viewable.
* **Student**: no account, no app, no login. Scan, enter UUID or enrollment number, tap Verify.
  Only students registered on that bus are accepted.

---

## Project layout

```
web/                 React 19 + Tailwind CSS 4 front end (Vite), built into dist/
  src/pages/         Checkin (student phone), Login, admin/* (console), portal/* (bus portals)
  src/components/    UI kit, StudentCard (the verified card), brand header, password dialog
  src/lib/           API client, tiny router, session, live updates (SSE or polling), formatting
public/              images and web manifest (copied into dist/)
src/
  app.js             Express app: security headers, setup gate, API routes, serves dist/
  server.js          long-running server for `npm start` (listen, timers, graceful shutdown)
  config.js          env, serverless detection, LAN detection
  db.js              async DB layer: node:sqlite locally or Turso/libSQL, migrations, housekeeping
  security.js        scrypt, HMAC, signed values, ID normalisation
  middleware/        session auth + CSRF, device identity, rate limits (memory or DB-shared)
  services/          QR tokens, trips, check-ins (anti-proxy rules), imports (CSV / Excel), live events, audit
  routes/            /api/auth, /api/admin, /api/incharge, /api/checkin
api/index.js         Vercel serverless entry          vercel.json   Vercel config
netlify/functions/   Netlify Functions entry          netlify.toml  Netlify config (CDN + /api function)
scripts/             seed, reset-admin, backup, security-test, serve-function
data/                local database, secret key, credentials, backups (git-ignored)
```

---

## Troubleshooting

* **Phones say "site can't be reached"** – they are not on the same network as the server, or
  the QR address is wrong. Check **Admin → Settings**; use a public HTTPS address for mobile data.
* **"QR code expired" on every scan** – the bus-screen device and the server clocks are not the
  issue (tokens are server-generated); the student took longer than 40 s between the scan and
  the page opening. Keep the camera on the screen until the page loads.
* **Student blocked: "phone linked to someone else"** – that phone was first used by another
  student. Either use the right phone or have the incharge mark them manually.
* **Lost admin password** – `npm run reset-admin`.
* **Windows prints an ExperimentalWarning about SQLite** – harmless; the npm scripts already
  silence it.
