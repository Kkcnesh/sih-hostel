/**
 * ============================================================================
 * POST /api/admin/updateVerification
 * ============================================================================
 * Toggles one applicant's VerificationStatus from the admin dashboard.
 * Admin-only (see _lib/adminAuth.js). Deliberately narrow: looks up the row
 * by ApplicationID and rewrites the WHOLE row with only VerificationStatus
 * changed (writeRowAt always writes a full row — there's no single-cell
 * write helper for Applications, only for Counters — see _lib/sheets.js),
 * so every other field is round-tripped unchanged.
 *
 * Independent of AllotmentStatus on purpose — this endpoint never reads or
 * writes AllotmentStatus/AllottedRoomNo/WaitlistPosition, and the
 * allocation engine (api/_lib/allocation.js) doesn't currently read
 * VerificationStatus either. Verifying documents and running allocation are
 * two separate admin actions; wiring "only Verified applicants are eligible
 * for allocation" into the engine's filtering would be a deliberate,
 * separate change — don't add that here.
 *
 * Request body: { applicationId, verificationStatus }
 * Response: { success, applicationId, verificationStatus } on success, or
 * { success:false, error } — 400 for an invalid applicationId/status, 404
 * if no row matches.
 * ============================================================================
 */

const { getSheetRows, writeRowAt, logEvent } = require('../_lib/sheets');
const { SHEET_NAMES, APPLICATIONS_COLUMNS, VERIFICATION_STATUSES } = require('../_lib/schema');
const { requireAdmin } = require('../_lib/adminAuth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  if (!requireAdmin(req, res)) return;

  const { applicationId, verificationStatus } = req.body || {};

  if (!applicationId || typeof applicationId !== 'string') {
    res.status(400).json({ success: false, error: 'Missing or invalid applicationId.' });
    return;
  }
  if (!VERIFICATION_STATUSES.includes(verificationStatus)) {
    res.status(400).json({ success: false, error: `verificationStatus must be one of: ${VERIFICATION_STATUSES.join(', ')}.` });
    return;
  }

  try {
    const applicationRows = await getSheetRows(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS);
    const row = applicationRows.find((r) => r.ApplicationID === applicationId);
    if (!row) {
      res.status(404).json({ success: false, error: `No application found with ID ${applicationId}.` });
      return;
    }

    const updatedRow = { ...row, VerificationStatus: verificationStatus };
    await writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, row._row, updatedRow);

    res.status(200).json({ success: true, applicationId, verificationStatus });
  } catch (err) {
    console.error('updateVerification handler error:', err);
    await logEvent('updateVerification', err.message, applicationId);
    res.status(500).json({ success: false, error: 'Something went wrong updating verification status. Please try again.' });
  }
};
