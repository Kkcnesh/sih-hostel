/**
 * ============================================================================
 * POST /api/admin/vacateRoom
 * ============================================================================
 * Fully removes a currently-Allotted student's application (e.g. the
 * student left permanently, and should be able to submit a brand-new
 * application for readmission with zero trace of the old one blocking or
 * confusing it) and, by default, auto-promotes the highest-priority
 * Waitlisted applicant in the same Hostel+RoomType pool into the freed seat
 * — same generateAllotmentPDF/sendAllotmentEmail single-recipient path
 * runAllocation.js uses for a fresh allotment. Admin-only (see _lib/adminAuth.js).
 *
 * Request body: { applicationId }
 *
 * FULL DELETION, NOT SOFT-DELETE (changed 2026-08-24 — this used to set
 * AllotmentStatus = "Vacated" and keep the row for record-keeping; the call
 * now is a genuine reapplication path, not an audit trail, so it's a real
 * delete):
 *   - The Applications ROW is deleted outright (_lib/sheets.js's
 *     deleteRow(), a real spreadsheets.batchUpdate deleteDimension request
 *     — not a blanked-out row, an actually shorter sheet). A reapplying
 *     student's submitApplication.js lookup-by-EnrolmentNo simply won't
 *     find a Pending-or-later row anymore, so they get a fresh submission,
 *     not "already verified, can't edit."
 *   - Their Eligibility row is NEVER touched — that's the base admission
 *     record (how they log in and how HostelChoice/CategoryReservation get
 *     derived), not application data, and has to survive for readmission
 *     to be possible at all.
 *   - Their Logs rows are NEVER touched — audit trail, not personal
 *     application data in the same sense as the Applications row.
 *   - Their Drive folder is NEVER deleted, only ARCHIVED — renamed from
 *     the plain `<EnrolmentNo>` to `<EnrolmentNo>-vacated-<YYYY-MM-DD>`
 *     (see _lib/drive.js's archiveStudentFolder()) so it's no longer
 *     discoverable under the plain EnrolmentNo name.
 *     getOrCreateStudentFolder()'s exact-name lookup won't match the
 *     renamed folder, so a reapplying student's first upload correctly
 *     creates a brand-new, empty folder — never mixing new uploads into
 *     old ones. Best-effort: caught and logged, never fails the request,
 *     same risk tolerance as the email sends below (see WRITE ORDERING).
 *
 * WRITE ORDERING — READ BEFORE TOUCHING THIS FILE: deleteRow() shifts every
 * row below the deleted one up by one, which would silently invalidate any
 * OTHER Applications row's `_row` position captured from the same
 * getSheetRows() call earlier in this request. So every other
 * position-dependent Applications write (roommate unlink, promotion,
 * waitlist renumbering) and the RoomInventory write are collected into
 * `writes` and awaited FIRST, as a batch — the row delete happens only
 * afterward, as a deliberately separate, later `await`, never mixed into
 * that same Promise.all. There is still no cross-row transaction here
 * (Sheets has none): if the delete itself fails after everything else
 * already succeeded, the room's Occupied count and any promoted student
 * are already correct, but the vacated student's row is left behind
 * (still marked Allotted to a room another row may now also claim) —
 * flagged rather than silently risked, and the response's `success: false`
 * on that path makes the admin aware to retry rather than assuming it
 * worked.
 *
 * ROOMMATE HANDLING: if the vacated student had a live paired roommate
 * (AllottedRoommateEnrolmentNo), that roommate's own row gets its
 * AllottedRoommateEnrolmentNo cleared (they keep their room, but the
 * dangling reference to a now-absent roommate is removed) — only if that
 * roommate's own field still points back to this student (mutuality check),
 * so a pre-existing data inconsistency elsewhere is never silently
 * "corrected" here. The vacated student is NOT auto-paired with whoever
 * gets promoted into the freed seat — that pairing decision is deliberately
 * out of scope; the promoted student is always seated alone
 * (AllottedRoommateEnrolmentNo stays blank on their row).
 *
 * PROMOTION PRIORITY: the promoted candidate is whoever already has the
 * lowest WaitlistPosition AMONG VERIFIED candidates in the pool (added
 * 2026-08-24 — an unverified waitlisted candidate is skipped over, never
 * auto-verified just to promote them, matching the same gating
 * runAllocation.js applies to fresh allotments). WaitlistPosition numbers
 * are assigned by allocatePool() in priority order (see _lib/allocation.js),
 * so "lowest WaitlistPosition" already IS "highest priority" for that pool;
 * there's no need to re-run compareCandidates() here. After promotion,
 * every remaining Waitlisted row in that pool with a WaitlistPosition
 * greater than the promoted student's old one shifts down by 1, so
 * positions stay contiguous from 1 (no gaps) — runAllocation.js's own
 * `waitlistStart` for a later run is computed from the highest surviving
 * WaitlistPosition in the pool, so a gap left here would silently waste a
 * number forever.
 * ============================================================================
 */

const { getSheetRows, writeRowAt, deleteRow, logEvent } = require('../_lib/sheets');
const { SHEET_NAMES, APPLICATIONS_COLUMNS, ROOM_INVENTORY_COLUMNS } = require('../_lib/schema');
const { requireAdmin } = require('../_lib/adminAuth');
const { generateAllotmentPDF } = require('../_lib/pdf');
const { sendAllotmentEmail } = require('../_lib/mailer');
const { archiveStudentFolder } = require('../_lib/drive');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  if (!requireAdmin(req, res)) return;

  const { applicationId } = req.body || {};
  if (!applicationId || typeof applicationId !== 'string') {
    res.status(400).json({ success: false, error: 'Missing or invalid applicationId.' });
    return;
  }

  try {
    const [applicationRows, roomRows] = await Promise.all([
      getSheetRows(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS),
      getSheetRows(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS)
    ]);

    const student = applicationRows.find((r) => r.ApplicationID === applicationId);
    if (!student) {
      res.status(404).json({ success: false, error: `No application found with ID ${applicationId}.` });
      return;
    }
    if (student.AllotmentStatus !== 'Allotted') {
      res.status(400).json({
        success: false,
        error: `Cannot vacate — this application's status is "${student.AllotmentStatus}", not "Allotted".`
      });
      return;
    }

    const oldRoomNo = student.AllottedRoomNo;
    const hostel = student.HostelChoice;
    const roomType = student.RoomTypePreference;

    const roomRow = roomRows.find((r) => r.RoomNo === oldRoomNo);
    if (!roomRow) {
      const message = `Application ${applicationId} is allotted to room "${oldRoomNo}", but that room was not found in RoomInventory.`;
      await logEvent('vacateRoom', message, student.EnrolmentNo);
      res.status(500).json({ success: false, error: message });
      return;
    }

    // Every entry here is a write OTHER than deleting the student's own
    // row — see the WRITE ORDERING note at the top of this file for why
    // that deletion has to happen separately, and later.
    const writes = [];

    // ---- Clear the ex-roommate's dangling reference, if any ----
    const roommateEnrolment = String(student.AllottedRoommateEnrolmentNo || '').trim();
    let roommateCleared = null;
    if (roommateEnrolment) {
      const roommateRow = applicationRows.find((r) => r.EnrolmentNo === roommateEnrolment && r.AllotmentStatus === 'Allotted');
      if (roommateRow && String(roommateRow.AllottedRoommateEnrolmentNo || '').trim() === student.EnrolmentNo) {
        writes.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, roommateRow._row, { ...roommateRow, AllottedRoommateEnrolmentNo: '' }));
        roommateCleared = { enrolmentNo: roommateRow.EnrolmentNo, name: roommateRow.Name };
      }
    }

    // ---- Auto-promote the top VERIFIED waitlisted student, if any ----
    // poolWaitlist is every waitlisted row in the pool, verified or not —
    // needed as the full set for the renumbering pass below. Promotion
    // ELIGIBILITY (verifiedPoolWaitlist) is a separate, narrower filter:
    // an unverified candidate is simply skipped in favor of the next
    // verified one in priority order (2026-08-24 verification-gating
    // decision — see runAllocation.js for the matching change on that
    // path). Never auto-verify someone just to promote them.
    const poolWaitlist = applicationRows
      .filter((r) =>
        r.ApplicationID !== applicationId &&
        r.HostelChoice === hostel &&
        r.RoomTypePreference === roomType &&
        r.AllotmentStatus === 'Waitlisted' &&
        Number(r.WaitlistPosition) > 0
      )
      .sort((a, b) => Number(a.WaitlistPosition) - Number(b.WaitlistPosition));
    const verifiedPoolWaitlist = poolWaitlist.filter((r) => r.VerificationStatus === 'Verified');

    let promoted = null;
    // Decrement now; if a promotion happens below, increment back — net zero
    // across the pair of writes (one room row, written once with the final
    // value), net -1 if the pool's waitlist was empty.
    let newOccupied = Math.max(0, Number(roomRow.Occupied || 0) - 1);

    if (verifiedPoolWaitlist.length > 0) {
      const promotee = verifiedPoolWaitlist[0];
      const promoteeOldPosition = Number(promotee.WaitlistPosition);

      const promotedRow = { ...promotee, AllotmentStatus: 'Allotted', AllottedRoomNo: oldRoomNo, WaitlistPosition: '' };
      writes.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, promotee._row, promotedRow));

      // Renumbering runs over the FULL pool (poolWaitlist), not just the
      // verified subset — a skipped-over unverified candidate still holds
      // a real WaitlistPosition that needs to stay contiguous with
      // everyone else's after this promotion; renumbering only the
      // verified rows would leave an unverified row's stale position
      // colliding with a verified row shifted down onto the same number.
      poolWaitlist
        .filter((r) => r.ApplicationID !== promotee.ApplicationID)
        .forEach((r) => {
          const pos = Number(r.WaitlistPosition);
          if (pos > promoteeOldPosition) {
            writes.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, r._row, { ...r, WaitlistPosition: pos - 1 }));
          }
        });

      newOccupied += 1;

      writes.push(
        generateAllotmentPDF(promotedRow, { hostel, roomType, roomNo: oldRoomNo, roommateName: '' })
          .then((pdfBuffer) => sendAllotmentEmail(promotedRow, pdfBuffer))
          .catch((err) => logEvent('vacateRoom', `Promotion email failed for ${promotee.EnrolmentNo}: ${err.message}`, promotee.EnrolmentNo))
      );

      promoted = { applicationId: promotee.ApplicationID, enrolmentNo: promotee.EnrolmentNo, name: promotee.Name, roomNo: oldRoomNo };
    }

    // Distinguishes "genuinely nobody waitlisted" from "somebody's
    // waitlisted but blocked on verification" — both leave `promoted` null
    // and the room vacant, but an admin looking at the response shouldn't
    // have to guess which one happened.
    const blockedByVerification = promoted === null && poolWaitlist.length > 0
      ? { enrolmentNo: poolWaitlist[0].EnrolmentNo, name: poolWaitlist[0].Name, waitlistPosition: Number(poolWaitlist[0].WaitlistPosition) }
      : null;

    writes.push(writeRowAt(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS, roomRow._row, { ...roomRow, Occupied: newOccupied }));

    // Every OTHER position-dependent write to Applications (and the
    // RoomInventory write, a different sheet, unaffected either way) lands
    // first, while `_row` positions captured at the top of this handler
    // are still valid — see the WRITE ORDERING note at the top of this file.
    await Promise.all(writes);

    // The actual deletion — deliberately its own separate, later `await`,
    // never merged into the Promise.all above. Everything the response
    // below needs (student.ApplicationID/EnrolmentNo/Name, oldRoomNo) was
    // already captured into local variables/the in-memory `student` object
    // before this point, so nothing after this line ever tries to re-read
    // the row that was just deleted.
    await deleteRow(SHEET_NAMES.APPLICATIONS, student._row);

    // Best-effort, same risk tolerance as the promotion email above — AND
    // still explicitly awaited before the response is sent, for the same
    // reason submitApplication.js awaits its confirmation email rather
    // than firing it and forgetting: a Vercel serverless function has no
    // guaranteed execution after res.json() returns, so an un-awaited call
    // here could just as easily never run at all. Wrapped in its own catch
    // so a failure is logged, not thrown — the core guarantees (room
    // freed, promotion applied, row deleted) have already happened by this
    // point regardless of whether the archive itself succeeds.
    await archiveStudentFolder(student.EnrolmentNo)
      .catch((err) => logEvent('vacateRoom', `Drive folder archive failed for ${student.EnrolmentNo}: ${err.message}`, student.EnrolmentNo));

    res.status(200).json({
      success: true,
      vacated: { applicationId: student.ApplicationID, enrolmentNo: student.EnrolmentNo, name: student.Name, roomNo: oldRoomNo },
      roommateCleared,
      promoted,
      blockedByVerification,
      room: { roomNo: oldRoomNo, hostel, roomType, capacity: Number(roomRow.Capacity || 0), occupied: newOccupied }
    });
  } catch (err) {
    console.error('vacateRoom handler error:', err);
    await logEvent('vacateRoom', err.message, applicationId);
    res.status(500).json({ success: false, error: 'Something went wrong vacating this room. Please try again.' });
  }
};
