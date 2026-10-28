# Lumens Ledger

The app is a static browser application. It uses a local, self-contained SQLite build; the database is persisted on the device in IndexedDB and can be exported or imported as a `.sqlite` file.

## Run

You can open `index.html` directly as a local `file://` in a desktop browser. This mode uses a self-contained SQLite engine and on-device IndexedDB; PWA installation and service-worker caching are unavailable for local files. To use those PWA features, serve this folder from `localhost` or an HTTPS static host.

On Windows, double-click `Start Lumens Ledger.bat` to start a loopback-only local server and open the app at `http://127.0.0.1:8000/index.html`. It uses Python's built-in static server (no Node.js); keep the server window open while using the app and close that window to stop the server. Install Python 3 if the launcher reports it is missing. If the app does not load and the launcher reports that port 8000 may be in use, close the older server window and run the launcher again.

There is no Node.js runtime, backend, or online asset dependency. The Tailwind CSS is compiled into `assets/app.css`; the self-contained SQLite build, icons, and fonts are local files in `vendor/` and `assets/`. Opening the app from `file://` works without the manifest or service worker; those PWA features are enabled only when served over localhost/HTTPS.

To rebuild the Tailwind stylesheet, download the standalone Tailwind CSS v3.4.17 CLI for your platform from the [official releases](https://github.com/tailwindlabs/tailwindcss/releases/tag/v3.4.17), then run it from this folder:

```powershell
.\tailwindcss.exe -i .\tailwind-input.css -o .\assets\app.css --minify
```

It scans `index.html` and `app.js` using `tailwind.config.js`; Node.js is not required.

## Data

- Sales and expenses are stored in the `sales` and `expenses` SQLite tables with UUIDv4 record IDs. The app upgrades older SQLite files in place, preserving existing records while adding missing fields and converting numeric IDs to UUIDv4.
- Expenses are date-based and include a description, optional payee/recipient, category, amount, payment method, and optional notes. The dashboard shows total expenses and sales collected after expenses; this is a basic cash comparison, not accounting profit.
- Sale dates are stored in SQLite and CSV as `MMDDYYYY`; the calendar uses ISO dates internally. Existing ISO-date SQLite databases are migrated automatically when opened or imported.
- Automatic backup history stores and displays its sale date as `MMDDYYYY`; the save timestamp remains a full ISO timestamp.
- The dashboard calculates Net Sales and VAT totals from active sales. The VAT total is hidden by default and can be shown from **Settings & Actions**. Its visibility preference is stored in the SQLite `settings` table, copied into daily SQLite exports, and included in CSV rows alongside the daily Net Sales and VAT totals.
- On first use, the app asks you to review and accept the current Terms and Conditions version. The acceptance version and timestamp are stored in this browser's local storage; a revised version requires renewed acceptance. See [TERMS_AND_CONDITIONS.md](./TERMS_AND_CONDITIONS.md). The terms are not legal or tax advice and should be reviewed by qualified Philippine counsel.
- Lumens Ledger is proprietary software. See [LICENSE.md](./LICENSE.md) for the usage license and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for bundled component licenses. The license and terms do not replace legal review.
- The desktop sidebar keeps the date picker visible while its quick actions scroll on shorter screens. The ledger can be searched and filtered by active/cancelled status, and long result lists are revealed in pages.
- Existing `ph_sales_tracker_v3` localStorage data is migrated once into SQLite on first startup.
- Choose **Choose Data Folder** once to grant the app access to a folder outside this project. The app writes one `LL-MMDDYYYY.sqlite` file per day and updates it after each sale or expense change, so no exit-time save is needed. On startup it opens today's matching file when folder access is available.
- Folder access uses the browser File System Access API in supported Chromium browsers. Some browsers do not expose this API to pages opened directly as `file://`; when that happens, the status explains the limitation, sales continue saving in browser-local IndexedDB, and exports use normal downloads. To use the chosen-folder workflow, open the app from localhost or HTTPS. Browser permissions may need to be granted again after a restart.
- **Export Day SQLite** saves the selected day's sales and expenses into the chosen folder; without folder access it downloads the file. The detailed CSV export includes both record types; a separate printable report CSV asks for a company name and report date, and includes daily totals plus sales and expense payment breakdowns. The SQLite and detailed CSV exports use `LL-MMDDYYYY` filenames; the report uses `LL-MMDDYYYY-REPORT.csv`.
- Selecting a past date with no matching SQLite file prompts to create one. Declining returns the calendar to today. Future dates and navigation into future months are disabled.
- SQLite import validates the sales schema and replaces only the selected day's sales and expenses when the imported file has an expenses table, preserving records for other dates. Importing an older file without that table leaves existing expenses for the selected date unchanged. The daily SQLite files can be opened and edited in DB Browser for SQLite. Before upgrading or transferring, keep an untouched copy of your exported SQLite file.
- New invoices use `INV-MMDDYYYY-XXXX` with a sequential number for that selected day. Descriptions are stored in uppercase; Card and Credit start at a 0% fee, which can still be changed manually.
- Sales can be cancelled from the edit form. Cancelled sales stay in the ledger with a strike-through, are excluded from totals, and are preserved in SQLite and CSV exports with their cancelled status. They can be restored from the edit form.
- A browser cannot run a scheduled save while the app is closed. The app therefore writes the daily SQLite file after each change rather than relying on an unreliable exit event. IndexedDB remains a local recovery copy; use **Automatic Daily Backups** to download it if needed.
- Press **F2** to open a new sale form. The amount field accepts decimals without number-spinner arrows.
