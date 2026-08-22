# Setup — GGSIPU Hostel Portal on Vercel

This app is now static HTML/CSS/JS (`index.html`, `application.html`, `status.html`, `css/`, `js/`) plus four Vercel Serverless Functions under `api/` that talk to Google Sheets and Google Drive using a **service account** — no Google Apps Script involved anymore.

You'll do five things, in order: create a Google Cloud service account, create the HostelDB sheet and share it with that service account, set two environment variables in Vercel, deploy, then seed some test data.

## 1. Create a Google Cloud service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (or pick an existing one) — name doesn't matter, e.g. "ggsipu-hostel-portal".
2. In the left sidebar: **APIs & Services → Library**. Search for and **enable** both:
   - **Google Sheets API**
   - **Google Drive API**
3. **APIs & Services → Credentials → Create Credentials → Service account**. Give it any name (e.g. "hostel-portal-backend"). You don't need to grant it any project-level IAM roles — access is controlled entirely by what you share with it in step 2 below.
4. Open the service account you just created → **Keys** tab → **Add Key → Create new key → JSON**. This downloads a `.json` file — **treat this file like a password.** Don't commit it to git, don't paste its contents anywhere public.
5. Open that downloaded JSON file and copy the `"client_email"` value (looks like `hostel-portal-backend@your-project.iam.gserviceaccount.com`) — you'll need it in the next step.

## 2. Create HostelDB and share it with the service account

1. Create a new Google Sheet, name it `HostelDB`.
2. Click **Share**, paste in the service account's email from step 1.5 above, set its role to **Editor**, and share (uncheck "notify people" — it's not a real inbox).
3. This app also uploads files to a Drive folder named `Hostel Applications` (created automatically the first time someone uploads a document) — the service account creates it under **its own Drive storage**, which is fine and needs no extra sharing. If you'd rather have it land somewhere you can browse, create a folder in **your own** Drive first, share *that* folder with the service account email as Editor too, then just don't worry about it further — the app finds-or-creates by name either way.
4. Create 5 tabs in HostelDB with these exact header rows (row 1 of each tab, exact spelling/order — the backend reads columns by name):

   **Eligibility**
   ```
   EnrolmentNo	Name	DOB	Course	School	Gender
   ```

   **Applications**
   ```
   ApplicationID	EnrolmentNo	Name	Nationality	DOB	Course	School	DateOfJoiningUniversity	CategoryResidence	CategoryReservation	FatherName	MotherName	ParentOfficeAddress	ParentOfficeTel	ParentOfficeEmail	ParentResidenceAddress	ParentResidenceTel	ParentResidenceEmail	GuardianOfficeAddress	GuardianOfficeTel	GuardianOfficeEmail	GuardianResidenceAddress	GuardianResidenceTel	GuardianResidenceEmail	EmergencyAddress	EmergencyTel	StudentMobile	StudentEmail	ExtraCurricular	HostelChoice	RoomTypePreference	RoommatePreferenceEnrolmentNo	PhotoDriveLink	AadharDriveLink	MarksheetsDriveLink	MedicalCertDriveLink	GuardianConsentDriveLink	AntiRaggingDriveLink	SubmissionTimestamp	VerificationStatus	AllotmentStatus	AllottedRoomNo	AllottedRoommateEnrolmentNo	WaitlistPosition
   ```

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

5. Seed a few real rows into **Eligibility** so you have something to log in with (`EnrolmentNo`, `Name`, `DOB` as `YYYY-MM-DD`, `Course`, `School`, `Gender`).
6. Copy the sheet's ID out of its URL — `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

## 3. Set the two environment variables in Vercel

The backend reads exactly two env vars — `GOOGLE_SERVICE_ACCOUNT_KEY` and `GOOGLE_SHEET_ID`. Nothing else.

**`GOOGLE_SHEET_ID`** — just paste the sheet ID from step 2.6.

**`GOOGLE_SERVICE_ACCOUNT_KEY`** — the *base64-encoded* contents of the JSON key file from step 1.4 (base64, not the raw JSON — this sidesteps a common real gotcha where the key's `private_key` field contains literal `\n` sequences that some env var UIs mangle). Produce it from a terminal, in the same folder as the downloaded key file:

```bash
# macOS
base64 -i your-key-file.json | tr -d '\n' | pbcopy

# Linux
base64 -w 0 your-key-file.json | xclip -selection clipboard
```

That copies the base64 string to your clipboard. In Vercel: **Project → Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `GOOGLE_SHEET_ID` | (from step 2.6) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | (the base64 string you just copied) |

Apply both to all environments (Production/Preview/Development) unless you want separate sheets per environment, in which case use separate service accounts/sheets and set the vars per-environment instead.

## 4. Deploy

If this project isn't linked to Vercel yet: `vercel` from this folder (or connect the GitHub repo in the Vercel dashboard — either way, Vercel auto-detects `api/*.js` as serverless functions and serves the root HTML/CSS/JS as static files, no `vercel.json` needed). It reads `package.json` and installs `googleapis` automatically during the build.

## 5. Test the flow end to end

1. Log in with an enrolment number + DOB you seeded into Eligibility
2. Fill out all 6 application steps, upload all 6 documents, submit
3. Check the Applications tab in HostelDB — a new row should appear with a real `ApplicationID` (format `HA-2026-000123`)
4. Check the `Hostel Applications/<EnrolmentNo>/` folder in the service account's Drive — the 6 uploaded files should be there
5. Reload and check the Status page pulls the just-submitted data back correctly

If something fails, check the function's logs in the Vercel dashiboard (**Project → Deployments → (latest) → Functions**) — every unexpected error is also written to the **Logs** tab in HostelDB with a timestamp/context, mirroring what the old Apps Script version did.

## What's different from the Apps Script version (know before you rely on this)

- **No lock/mutex protecting the `ApplicationID` counter.** The old version used Apps Script's `LockService` to make counter increments atomic; Vercel functions have no equivalent, and Sheets' API has no compare-and-swap primitive to build one on top of. Under truly simultaneous submissions from two different students, two rows could theoretically get the same `ApplicationID`. Flagged clearly in a comment at the top of `api/submitApplication.js` — not something this pass tries to solve, since a real fix means a different datastore for the counter specifically (Vercel KV, Firestore, etc.), not a Sheets-based patch.
- **No `setupSheets()`-equivalent bootstrap function** — the 5 tabs + headers in step 2.4 above have to be created by hand once. Nothing calls itself to check they're correct at runtime, so a typo'd header name will surface as a silent "column not found" error rather than anything obvious.
