/**
 * ============================================================================
 * POST /api/admin/syncHeaders
 * ============================================================================
 * Permanent fix for a problem this project has hit three times now: a
 * schema change adds a new column name to one of the `*_COLUMNS` arrays in
 * api/_lib/schema.js, but the LIVE Google Sheet's header row (row 1) never
 * gets the matching cell added — and since _lib/sheets.js's getHeaderMap()/
 * assertColumnsExist() (added 2026-08-24 for the column-drift fix) resolve
 * every read/write by NAME against that real header row, a missing header
 * cell means every read/write to that sheet throws until someone manually
 * adds it. That's been a manual, error-prone fire-drill every time — this
 * endpoint does it instead, safely and idempotently.
 *
 * For each of Applications/Eligibility/RoomInventory: reads the sheet's
 * real header row, compares it against the authoritative column list in
 * _lib/schema.js, and appends (never reorders/removes/overwrites) any
 * column the schema expects but the live header doesn't have yet — see
 * _lib/sheets.js's appendHeaderColumns() for exactly how. Counters/Logs
 * are deliberately NOT included: Counters is a fixed 2-column sheet that's
 * never grown, and Logs is written positionally by appendRow() with no
 * schema-driven column list to compare against in the first place.
 *
 * Safe to run repeatedly — a sheet with nothing missing just reports an
 * empty `added` list for it, no writes happen. Admin-only (see
 * _lib/adminAuth.js), wired to a "Sync Sheet Headers" button on
 * admin.html's dashboard.
 * ============================================================================
 */

const { getHeaderMap, appendHeaderColumns, logEvent } = require('../_lib/sheets');
const { SHEET_NAMES, APPLICATIONS_COLUMNS, ELIGIBILITY_COLUMNS, ROOM_INVENTORY_COLUMNS } = require('../_lib/schema');
const { requireAdmin } = require('../_lib/adminAuth');

const SHEETS_TO_SYNC = [
  { sheet: SHEET_NAMES.APPLICATIONS, columns: APPLICATIONS_COLUMNS },
  { sheet: SHEET_NAMES.ELIGIBILITY, columns: ELIGIBILITY_COLUMNS },
  { sheet: SHEET_NAMES.ROOM_INVENTORY, columns: ROOM_INVENTORY_COLUMNS }
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  if (!requireAdmin(req, res)) return;

  try {
    const results = [];

    for (const { sheet, columns } of SHEETS_TO_SYNC) {
      const header = await getHeaderMap(sheet);
      const missing = columns.filter((col) => header.indexByName[col] === undefined);

      if (missing.length > 0) {
        await appendHeaderColumns(sheet, missing);
      }

      results.push({ sheet, added: missing });
    }

    const totalAdded = results.reduce((sum, r) => sum + r.added.length, 0);

    res.status(200).json({
      success: true,
      message: totalAdded > 0
        ? `Added ${totalAdded} missing header column(s).`
        : 'Nothing missing — every sheet header already matches the schema.',
      results
    });
  } catch (err) {
    console.error('syncHeaders handler error:', err);
    await logEvent('syncHeaders', err.message, '');
    res.status(500).json({ success: false, error: 'Something went wrong syncing sheet headers. Please try again.' });
  }
};
