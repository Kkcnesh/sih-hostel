/**
 * ============================================================================
 * GOOGLE SHEETS CLIENT + LOW-LEVEL ROW HELPERS
 * ============================================================================
 * Auth: OAuth 2.0 with a long-lived refresh token, acting as a real Google
 * account (not a service account — Cloud Console org policy on this project
 * blocks creating service account keys). GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET identify the OAuth client; GOOGLE_REFRESH_TOKEN is
 * produced once locally via scripts/get-refresh-token.js — see SETUP.md.
 * All three are read from env vars, never hardcoded, never logged.
 *
 * The googleapis OAuth2 client refreshes its short-lived access token
 * automatically on every request using the refresh token — no manual
 * refresh logic needed here.
 *
 * These are intentionally low-level/generic (read a sheet's rows, write a
 * row at a position, append a row) — the same role getSheet()/
 * findRowByValue()/rowToObject() played in the project's original Apps
 * Script backend. Business logic (which sheet, which columns, what a
 * "duplicate" means) stays in the individual /api/*.js handlers, not here.
 * ============================================================================
 */

const { google } = require('googleapis');
const { rowToObject, SHEET_NAMES } = require('./schema');

let cachedAuth = null;
let cachedSheetsClient = null;

/** Builds an OAuth2 client from GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN, reused across invocations within the same warm serverless instance. */
function getAuth() {
  if (cachedAuth) return cachedAuth;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN environment variables are not all set. See SETUP.md.');
  }

  cachedAuth = new google.auth.OAuth2(clientId, clientSecret);
  cachedAuth.setCredentials({ refresh_token: refreshToken });
  return cachedAuth;
}

function getSheetsClient() {
  if (!cachedSheetsClient) {
    cachedSheetsClient = google.sheets({ version: 'v4', auth: getAuth() });
  }
  return cachedSheetsClient;
}

/** The HostelDB spreadsheet's ID — GOOGLE_SHEET_ID env var (copy it from the sheet's URL). See SETUP.md. */
function getSpreadsheetId() {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) {
    throw new Error('GOOGLE_SHEET_ID environment variable is not set. See SETUP.md.');
  }
  return id;
}

/** Spreadsheet-safe column letter for a 0-indexed column position (0 -> A, 25 -> Z, 26 -> AA, ...). */
function columnLetter(index) {
  let letters = '';
  let n = index;
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

/**
 * Fixed 2026-08-24: getSheetRows()/writeRowAt() used to assume a `columns`
 * array's declared order (e.g. APPLICATIONS_COLUMNS) always matched the
 * live sheet's actual left-to-right column order — i.e. purely positional
 * access ("column N in the array IS column N in the sheet"), same class of
 * bug as a hardcoded numeric index, just spelled as array position instead
 * of a literal number. That was only ever true as long as every schema
 * change (this project has had several in one day — see schema.js's
 * "Appended ..." comments) was mirrored into the live sheet's header row in
 * the exact same order, and nothing here ever verified that. When it
 * silently drifted, reads pulled the right-looking value from the wrong
 * physical cell (e.g. the admin dashboard showing a home address under
 * "Hostel/Room Type") and writes correspondingly wrote values into the
 * wrong physical column.
 *
 * getHeaderMap() is the fix: it reads the sheet's REAL header row (row 1)
 * and resolves every column lookup against that, every time — immune to
 * the live sheet's physical order ever diverging from a `columns` array's
 * declared order, and immune to the divergence being anywhere (not just an
 * append at the end). If an expected column name isn't found in the live
 * header at all, that's a genuine drift and gets a loud, specific error
 * (assertColumnsExist() below) instead of silently defaulting to '' —
 * exactly the kind of silent failure this whole fix exists to eliminate.
 *
 * Cached per sheet name for the life of this warm serverless instance —
 * same caching philosophy as cachedAuth/cachedSheetsClient above (a header
 * edit made while an instance is warm won't be picked up until the next
 * cold start; this project already accepts that same tradeoff for auth).
 */
const headerCache = new Map(); // sheetName -> { names: string[], indexByName: {name: index} }

async function getHeaderMap(sheetName) {
  if (headerCache.has(sheetName)) return headerCache.get(sheetName);

  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!1:1`
  });

  const names = (res.data.values && res.data.values[0]) || [];
  const indexByName = {};
  names.forEach((name, i) => {
    const trimmed = String(name || '').trim();
    if (trimmed) indexByName[trimmed] = i; // first occurrence wins if a header name is ever duplicated
  });

  const headerMap = { names, indexByName };
  headerCache.set(sheetName, headerMap);
  return headerMap;
}

/** Throws a clear, actionable error naming exactly which expected column(s) are missing from the live sheet's header row — a schema/sheet drift, not something to paper over by silently reading/writing '' into the wrong place. */
function assertColumnsExist(sheetName, columns, indexByName) {
  const missing = columns.filter((col) => indexByName[col] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${sheetName}'s header row (row 1) is missing column(s): ${missing.join(', ')}. ` +
      `The live sheet's header no longer matches api/_lib/schema.js — see SETUP.md.`
    );
  }
}

/**
 * Reads every data row (everything after the header) from a sheet and
 * returns it as an array of {...columnFields, _row} objects, where `_row`
 * is the row's 1-indexed position in the actual sheet (header is row 1, so
 * the first data row is row 2) — callers use `_row` directly when they need
 * to write back to that exact row later, the same way Code.gs's
 * findRowByValue() returned a row NUMBER for a subsequent getRange() call.
 */
async function getSheetRows(sheetName, columns) {
  const sheets = getSheetsClient();
  const header = await getHeaderMap(sheetName);
  assertColumnsExist(sheetName, columns, header.indexByName);

  const maxIndex = Math.max(...columns.map((col) => header.indexByName[col]));
  const range = `${sheetName}!A2:${columnLetter(maxIndex)}`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range
  });

  const rows = res.data.values || [];
  return rows.map((rowValues, i) => ({
    ...rowToObject(columns, rowValues, header.indexByName),
    _row: i + 2 // +2: 1-indexed, plus the header row
  }));
}

/**
 * Writes one row at an exact 1-indexed sheet row — used for both inserting
 * a brand-new Applications row and updating an existing one in place.
 * Read-modify-write across the sheet's FULL physical header width (not
 * just the columns this call's `columns` param knows about): the current
 * row is read first, only the named `columns` are overwritten in place at
 * their REAL physical positions, then the whole row is written back. This
 * preserves any live column outside the caller's `columns` schema (e.g.
 * one added directly to the sheet ahead of a code deploy) instead of a
 * naive positional overwrite blanking it out.
 */
async function writeRowAt(sheetName, columns, rowNumber, rowObject) {
  const sheets = getSheetsClient();
  const header = await getHeaderMap(sheetName);
  assertColumnsExist(sheetName, columns, header.indexByName);

  const range = `${sheetName}!A${rowNumber}:${columnLetter(header.names.length - 1)}${rowNumber}`;

  const currentRes = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range
  });
  const currentValues = (currentRes.data.values && currentRes.data.values[0]) || [];
  while (currentValues.length < header.names.length) currentValues.push('');

  columns.forEach((col) => {
    currentValues[header.indexByName[col]] = rowObject[col] === undefined ? '' : rowObject[col];
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range,
    valueInputOption: 'RAW',
    resource: { values: [currentValues] }
  });
}

/**
 * Appends new header cells to `sheetName`'s row 1, starting right after the
 * last currently-populated header cell — NEVER touches, reorders, or
 * overwrites an existing header cell, only ever extends the row rightward.
 * The only caller is POST /api/admin/syncHeaders (see api/admin/syncHeaders.js)
 * — this is the permanent fix for a recurring problem: a column added to one
 * of the `*_COLUMNS` arrays in _lib/schema.js needs a matching header cell
 * on the LIVE sheet before assertColumnsExist() above will allow any read
 * or write to that sheet to succeed, and that's been a manual, error-prone
 * fire-drill every time (see schema.js's "Appended ..." comments) — this
 * lets an admin fix it with one button instead of hand-editing the sheet.
 *
 * Invalidates this sheet's cached header map afterward, so the very next
 * getSheetRows()/writeRowAt() call — even within the same warm serverless
 * instance that just ran the sync — sees the new columns immediately
 * instead of the stale pre-sync header.
 */
async function appendHeaderColumns(sheetName, newColumnNames) {
  if (newColumnNames.length === 0) return;

  const header = await getHeaderMap(sheetName);
  const sheets = getSheetsClient();
  const startCol = header.names.length; // first empty column, 0-indexed
  const endCol = startCol + newColumnNames.length - 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!${columnLetter(startCol)}1:${columnLetter(endCol)}1`,
    valueInputOption: 'RAW',
    resource: { values: [newColumnNames] }
  });

  headerCache.delete(sheetName);
}

/** Appends one row to the end of a sheet — used for Logs, where row position/order doesn't matter. */
async function appendRow(sheetName, rowValues) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [rowValues] }
  });
}

/** Lightweight failure log — enough context to debug later, not a full audit trail. Mirrors Code.gs's logEvent(); swallows its own errors so a logging failure never masks the real one. */
async function logEvent(context, message, enrolmentNo) {
  try {
    await appendRow(SHEET_NAMES.LOGS, [new Date().toISOString(), enrolmentNo || '', context, message]);
  } catch (err) {
    console.error('logEvent failed:', err.message);
  }
}

module.exports = {
  getAuth,
  getSheetsClient,
  getSpreadsheetId,
  getHeaderMap,
  appendHeaderColumns,
  getSheetRows,
  writeRowAt,
  appendRow,
  logEvent
};
