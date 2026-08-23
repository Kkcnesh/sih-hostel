# Setup — GGSIPU Hostel Portal on Vercel

This app is now static HTML/CSS/JS (`index.html`, `application.html`, `status.html`, `css/`, `js/`) plus Vercel Serverless Functions under `api/` that talk to Google Sheets, Google Drive, and (as of the email-notification feature) the Gmail API using **OAuth 2.0 with a refresh token, acting as your own Google account** — not a service account (Cloud Console's org policy on this project blocks creating service account keys, so this is the workaround). No Google Apps Script involved anymore.

You'll do six things, in order: create an OAuth client in Google Cloud, run a one-time local script to get a refresh token, create the HostelDB sheet under your own account, set three environment variables in Vercel, deploy, then seed some test data.

## 1. Create a Google Cloud OAuth client

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (or pick an existing one) — name doesn't matter, e.g. "ggsipu-hostel-portal".
2. In the left sidebar: **APIs & Services → Library**. Search for and **enable** all three:
   - **Google Sheets API**
   - **Google Drive API**
   - **Gmail API** — needed for the application-confirmation and allotment-letter emails (`api/_lib/mailer.js`)
3. **APIs & Services → OAuth consent screen** — set it up if you haven't already (External is fine for testing; add your own Google account as a test user if it asks).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**. Application type: **Desktop app** (not "Web application" — Desktop-app clients are allowed to use a `localhost` redirect without pre-registering it, which is what the local script in step 2 needs). Name it anything, e.g. "hostel-portal-local".
5. After creating it, copy the **Client ID** and **Client secret** shown — you'll need both in the next step.

## 2. Get a refresh token (run once, locally)

> **⚠️ Existing deployments: you MUST regenerate this token.** As of the
> email-notification feature (`api/_lib/mailer.js`), `scripts/get-refresh-token.js`
> requests one additional OAuth scope —
> `https://www.googleapis.com/auth/gmail.send` — alongside the two it already
> requested. OAuth scopes are baked into a refresh token at the moment it's
> issued; an existing `GOOGLE_REFRESH_TOKEN` generated before this change
> does **not** have the Gmail scope and cannot be upgraded in place. If you
> already have a working deployment, you must re-run step 2 below and
> replace `GOOGLE_REFRESH_TOKEN` in Vercel with the newly-printed value, or
> every confirmation/allotment email will fail with an
> `insufficient authentication scopes` error (the application/allotment
> writes themselves will still succeed — see the "Testing" note in
> `api/_lib/mailer.js` — but no email will go out until the token is
> replaced). The full scope list requested is now:
> ```
> https://www.googleapis.com/auth/spreadsheets
> https://www.googleapis.com/auth/drive
> https://www.googleapis.com/auth/gmail.send
> ```

1. In this project folder, install dependencies if you haven't: `npm install`.
2. Copy `.env.example` to `.env` and fill in the Client ID/secret from step 1.5:
   ```
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```
   (`.env` is gitignored — it never gets committed.)
3. Run:
   ```bash
   npm run get-refresh-token
   ```
4. It prints a Google URL — open it in your browser and approve access **using the Google account that should own the HostelDB sheet and the uploaded documents** (your own account, or a dedicated one you control — whichever you want the data to actually live under).
5. After you approve, the browser redirects back to the script automatically and it prints your refresh token in the terminal. Copy it — you'll paste it into Vercel in step 4.

   If it says no refresh token came back: this Google account most likely already authorized this OAuth client once before. Revoke it at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and run the script again.

## 3. Create HostelDB under your own account

1. Create a new Google Sheet, name it `HostelDB`, under the same Google account you authorized in step 2.4 — no sharing step needed, since the app now acts as that account directly rather than a separate robot account you'd have to grant access to.
2. This app also uploads files to a Drive folder named `Hostel Applications` (created automatically the first time someone uploads a document), in that same account's Drive.
3. Create 5 tabs in HostelDB with these exact header rows (row 1 of each tab, exact spelling/order). **Correction: the backend does NOT actually read columns by name** — `getSheetRows()`/`writeRowAt()` in `api/_lib/sheets.js` read/write a fixed `A2:<lastCol>` range purely by COLUMN POSITION, matching each code-side `*_COLUMNS` array index to a letter. The header row is for human reference only; code never looks at it. This means column ORDER must match the arrays in `api/_lib/schema.js` exactly, and any future column must be appended at the end, never inserted/reordered/removed — doing either would silently misalign every existing row.

   **Eligibility** — `CategoryReservation` added 2026-08-23 to lock reservation
   category (GEN/SC/ST/OBC/EWS/PWD) against this sheet instead of leaving it
   self-declared on the application form. Appended at the end — see the
   caveat above. If your live sheet predates this, add one header cell after
   `Gender`, then fill in a value for **every existing row**, including any
   test students — a blank cell defaults to `GEN` (see
   `deriveCategoryReservation()` in `api/_lib/schema.js`), so nobody is
   blocked, but anyone who should actually be SC/ST/OBC/EWS/PWD won't get
   correct allocation priority until you fill it in.
   ```
   EnrolmentNo	Name	DOB	Course	School	Gender	CategoryReservation
   ```

   **Applications** — updated 2026-08-23 for the structured-address UI redesign; the 19 columns from `FatherPhone` onward are new (appended at the end — see the caveat above). If your live sheet predates this, add these 19 header cells after the existing `WaitlistPosition` column; don't touch anything before it.
   ```
   ApplicationID	EnrolmentNo	Name	Nationality	DOB	Course	School	DateOfJoiningUniversity	CategoryResidence	CategoryReservation	FatherName	MotherName	ParentOfficeAddress	ParentOfficeTel	ParentOfficeEmail	ParentResidenceAddress	ParentResidenceTel	ParentResidenceEmail	GuardianOfficeAddress	GuardianOfficeTel	GuardianOfficeEmail	GuardianResidenceAddress	GuardianResidenceTel	GuardianResidenceEmail	EmergencyAddress	EmergencyTel	StudentMobile	StudentEmail	ExtraCurricular	HostelChoice	RoomTypePreference	RoommatePreferenceEnrolmentNo	PhotoDriveLink	AadharDriveLink	MarksheetsDriveLink	MedicalCertDriveLink	GuardianConsentDriveLink	AntiRaggingDriveLink	SubmissionTimestamp	VerificationStatus	AllotmentStatus	AllottedRoomNo	AllottedRoommateEnrolmentNo	WaitlistPosition	FatherPhone	MotherPhone	ParentResidenceHouseNo	ParentResidenceStreetArea	ParentResidenceCity	ParentResidenceDistrict	ParentResidenceState	ParentResidencePincode	ParentResidenceLandmark	GuardianName	GuardianRelationship	GuardianPhone	GuardianHouseNo	GuardianStreetArea	GuardianCity	GuardianDistrict	GuardianState	GuardianPincode	GuardianLandmark
   ```

   Also note: as of this same change, the reservation-category value that used to be `PH` is now `PWD` (`api/_lib/allocation.js`'s `priorityTier()` checks for `PWD`) — if you have existing rows with `CategoryReservation` = `PH`, either leave them (they'll just stop being treated as tier-1/PwBD in future allocation runs) or hand-edit them to `PWD` in the sheet.

   **RoomInventory**
   ```
   RoomNo	Hostel	RoomType	Capacity	Occupied
   ```

   **Counters** — header row, then exactly one data row under it:
   ```
   CounterName	NextValue
   ApplicationID	0
   ```

   **Logs**
   ```
   Timestamp	EnrolmentNo	Context	Message
   ```

   (Tip: paste each header row into cell A1 of its tab — Sheets will split it across columns automatically if you paste it as tab-separated text.)

4. Seed a few real rows into **Eligibility** so you have something to log in with (`EnrolmentNo`, `Name`, `DOB` as `YYYY-MM-DD`, `Course`, `School`, `Gender`, `CategoryReservation` — one of `GEN`/`SC`/`ST`/`OBC`/`EWS`/`PWD`).
5. Copy the sheet's ID out of its URL — `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

## 4. Set the environment variables in Vercel

In Vercel: **Project → Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | Same value as in your local `.env` (step 2.2) |
| `GOOGLE_CLIENT_SECRET` | Same value as in your local `.env` (step 2.2) |
| `GOOGLE_REFRESH_TOKEN` | The token printed by `npm run get-refresh-token` (step 2.5) |
| `GOOGLE_SHEET_ID` | The sheet ID from step 3.5 |
| `ADMIN_SECRET` | Any long random string you generate yourself (e.g. `openssl rand -hex 32`) — protects `/api/runAllocation` and every `/api/admin/*` endpoint, see below |

Apply all five to every environment (Production/Preview/Development) unless you deliberately want different sheets per environment, in which case use separate refresh tokens/sheets and set the vars per-environment instead.

### `ADMIN_SECRET`, the admin API, and `admin.html`

`POST /api/runAllocation` and every `POST /api/admin/*` endpoint are admin-only. There's no admin login system yet, so they're protected the simplest way that isn't wide open: the request must include a header

```
Authorization: Bearer <ADMIN_SECRET>
```

matching the `ADMIN_SECRET` env var, or the endpoint returns 401 (and if `ADMIN_SECRET` isn't set at all, it returns 500 rather than silently allowing unauthenticated access — see `api/_lib/adminAuth.js`, the one shared check every admin endpoint calls first). Only share this value with whoever is supposed to administer the portal — anyone with it can view every applicant's data, toggle verification, and trigger a real allotment run. Example call:

```bash
curl -X POST https://your-deployment.vercel.app/api/runAllocation \
  -H "Authorization: Bearer YOUR_ADMIN_SECRET"
```

**`admin.html`** is the dashboard: navigate to it directly (`https://your-deployment.vercel.app/admin.html` — it's not linked from anywhere in the student-facing nav or footer on purpose). It asks for the admin secret once per browser tab, stores it in `sessionStorage`, and uses it to call:

- `POST /api/admin/listApplications` — every Applications row, for the table
- `POST /api/admin/updateVerification` — toggles one applicant's `VerificationStatus` between `Pending`/`Verified` (independent of `AllotmentStatus` — verifying documents doesn't trigger or affect allocation)
- `POST /api/runAllocation` — the "Run Allocation" button

See the comment at the top of `api/runAllocation.js` for exactly which priority policy it implements (a scoped-down 3-tier version of GGSIPU's real policy — the full version needs a distance field the application form doesn't collect yet) and its idempotency behavior (safe to rerun as new applications come in; never re-shuffles already-Allotted/Waitlisted rows). Note that `VerificationStatus` is NOT currently read by the allocation engine — a "Not Processed" application is eligible for allocation regardless of verification state. Making verification a prerequisite for allocation would be a deliberate change to `api/_lib/allocation.js`'s candidate filtering, not something either of these features implies on its own.

## 5. Deploy

If this project isn't linked to Vercel yet: `vercel` from this folder (or connect the GitHub repo in the Vercel dashboard — either way, Vercel auto-detects `api/*.js` as serverless functions and serves the root HTML/CSS/JS as static files, no `vercel.json` needed). It reads `package.json` and installs `googleapis` automatically during the build (`dotenv` is a devDependency, only used by the local `get-refresh-token` script — it's not needed or used at runtime).

## 6. Test the flow end to end

1. Log in with an enrolment number + DOB you seeded into Eligibility
2. Fill out all 6 application steps, upload all 6 documents, submit
3. Check the Applications tab in HostelDB — a new row should appear with a real `ApplicationID` (format `HA-2026-000123`)
4. Check the `Hostel Applications/<EnrolmentNo>/` folder in the Drive of the account you authorized in step 2.4 — the 6 uploaded files should be there
5. Check the `StudentEmail` inbox from that same application — a confirmation email should arrive with the application PDF attached (only that address, never any parent/guardian email column)
6. Reload and check the Status page pulls the just-submitted data back correctly
7. Run `POST /api/runAllocation` (see the `ADMIN_SECRET` section above) and confirm any student it allots gets a second email with the formal allotment letter PDF attached, and that a waitlisted student gets no email

If something fails, check the function's logs in the Vercel dashboard (**Project → Deployments → (latest) → Functions**) — every unexpected error, including a failed email send, is also written to the **Logs** tab in HostelDB with a timestamp/context (email failures never block the application/allocation write itself — see `api/_lib/mailer.js`).

Note: the OAuth consent screen may show an "unverified app" warning when you approve access in step 2 (now that it requests the `gmail.send` scope) if that consent screen hasn't gone through Google's verification — this is expected for a project running in Testing mode with yourself listed as a test user, and doesn't block anything for this hackathon/pilot scope.

## What's different from the original Apps Script version (know before you rely on this)

- **No lock/mutex protecting the `ApplicationID` counter.** The Apps Script version used `LockService` to make counter increments atomic; Vercel functions have no equivalent, and the Sheets API has no compare-and-swap primitive to build one on top of. Under truly simultaneous submissions from two different students, two rows could theoretically get the same `ApplicationID`. Flagged clearly in a comment at the top of `api/submitApplication.js` — not something this pass tries to solve, since a real fix means a different datastore for the counter specifically (Vercel KV, Firestore, etc.), not a Sheets-based patch.
- **No `setupSheets()`-equivalent bootstrap function** — the 5 tabs + headers in step 3.3 above have to be created by hand once. Nothing calls itself to check they're correct at runtime, so a typo'd header name will surface as a silent "column not found" error rather than anything obvious.
- **The refresh token is tied to whichever Google account you authorized in step 2.4** — if that person's Google account gets suspended/deleted, or they manually revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), every `/api/*` call starts failing until someone re-runs `npm run get-refresh-token` and updates `GOOGLE_REFRESH_TOKEN` in Vercel. Worth using an account you control long-term (a shared/admin account), not a personal one that might change hands.
