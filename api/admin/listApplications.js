/**
 * ============================================================================
 * POST /api/admin/listApplications
 * ============================================================================
 * Feeds admin.html's applications table. Admin-only (see _lib/adminAuth.js).
 *
 * Returns a curated subset of Applications columns — enough for the
 * dashboard table, not the full 43-column row (no addresses/phone numbers/
 * Drive links here; that level of detail belongs to the not-yet-built
 * "view one application" screen, not a list view).
 * ============================================================================
 */

const { getSheetRows } = require('../_lib/sheets');
const { SHEET_NAMES, APPLICATIONS_COLUMNS } = require('../_lib/schema');
const { requireAdmin } = require('../_lib/adminAuth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  if (!requireAdmin(req, res)) return;

  try {
    const rows = await getSheetRows(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS);

    const applications = rows.map((row) => ({
      applicationId: row.ApplicationID,
      enrolmentNo: row.EnrolmentNo,
      name: row.Name,
      hostel: row.HostelChoice,
      roomType: row.RoomTypePreference,
      categoryResidence: row.CategoryResidence,
      categoryReservation: row.CategoryReservation,
      verificationStatus: row.VerificationStatus,
      allotmentStatus: row.AllotmentStatus,
      allottedRoomNo: row.AllottedRoomNo,
      allottedRoommateEnrolmentNo: row.AllottedRoommateEnrolmentNo,
      waitlistPosition: row.WaitlistPosition,
      submittedDate: row.SubmissionTimestamp
    }));

    res.status(200).json({ success: true, applications });
  } catch (err) {
    console.error('listApplications handler error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong loading applications. Please try again.' });
  }
};
