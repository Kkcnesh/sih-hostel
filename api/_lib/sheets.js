/**
 * ============================================================================
 * GOOGLE SHEETS CLIENT + LOW-LEVEL ROW HELPERS
 * ============================================================================
 * Auth: a service account key read from the GOOGLE_SERVICE_ACCOUNT_KEY env
 * var (base64-encoded JSON — see SETUP.md for exactly how to produce it).
 * Never logged, never hardcoded.
 *
 * These are intentionally low-level/generic (read a sheet's rows, write a
 * row at a position, append a row) — the same role getSheet()/
 * findRowByValue()/rowToObject() played in Code.gs. Business logic
 * (which sheet, which columns, what a "duplicate" means) stays in the
 * individual /api/*.js handlers, not here.
 * ============================================================================
 */

const { google } = require('googleapis');
const { rowToObject, SHEET_NAMES } = require('./schema');

let cachedAuth = null;
let cachedSheetsClient = null;

/** Decodes GOOGLE_SERVICE_ACCOUNT_KEY (base64 JSON) into a GoogleAuth client, reused across invocations within the same warm serverless instance. */
function getAuth() {
  if (cachedAuth) return cachedAuth;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set. See SETUP.md.');
  }

  let credentials;
  try {
    credentials = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid base64-encoded JSON. See SETUP.md.');
  }

  cachedAuth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]
  });
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
 * Reads every data row (everything after the header) from a sheet and
 * returns it as an array of {...columnFields, _row} objects, where `_row`
 * is the row's 1-indexed position in the actual sheet (header is row 1, so
 * the first data row is row 2) — callers use `_row` directly when they need
 * to write back to that exact row later, the same way Code.gs's
 * findRowByValue() returned a row NUMBER for a subsequent getRange() call.
 */
async function getSheetRows(sheetName, columns) {
  const sheets = getSheetsClient();
  const lastCol = columnLetter(columns.length - 1);
  const range = `${sheetName}!A2:${lastCol}`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range
  });

  const rows = res.data.values || [];
  return rows.map((rowValues, i) => ({
    ...rowToObject(columns, rowValues),
    _row: i + 2 // +2: 1-indexed, plus the header row
  }));
}

/** Writes one full row (in `columns` order) at an exact 1-indexed sheet row — used for both inserting a brand-new Applications row and updating an existing one in place. */
async function writeRowAt(sheetName, columns, rowNumber, rowObject) {
  const sheets = getSheetsClient();
  const lastCol = columnLetter(columns.length - 1);
  const rowValues = columns.map((col) => (rowObject[col] === undefined ? '' : rowObject[col]));

  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A${rowNumber}:${lastCol}${rowNumber}`,
    valueInputOption: 'RAW',
    resource: { values: [rowValues] }
  });
}

/** Writes a single cell — used only for the Counters sheet's NextValue increment. */
async function writeCell(sheetName, cellA1, value) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!${cellA1}`,
    valueInputOption: 'RAW',
    resource: { values: [[value]] }
  });
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
  getSheetRows,
  writeRowAt,
  writeCell,
  appendRow,
  logEvent
};
