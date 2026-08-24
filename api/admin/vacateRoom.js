/**
 * ============================================================================
 * POST /api/admin/vacateRoom
 * ============================================================================
 * Marks a currently-Allotted student's room as vacated (e.g. the student
 * left permanently) and, by default, auto-promotes the highest-priority
 * Waitlisted applicant in the same Hostel+RoomType pool into the freed seat
 * — same generateAllotmentPDF/sendAllotmentEmail single-recipient path
 * runAllocation.js uses for a fresh allotment. Admin-only (see _lib/adminAuth.js).
 *
 * Request body: { applicationId }
 *
 * This writes to the exact same RoomInventory.Occupied counts and
 * Applications allotment fields (_lib/allocation.js's runAllocation) depends
 * on being consistent — every write below is collected into `writes` and
 * fired together via one Promise.all, but there is no cross-row transaction
 * here (Sheets has none), so the ordering of the writes array is chosen so
 * that a partial failure leaves the sheet in the least-surprising state
 * (the vacate itself is queued first).
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
 * lowest WaitlistPosition in the pool — WaitlistPosition numbers are
 * assigned by allocatePool() in priority order (see _lib/allocation.js), so
 * "lowest WaitlistPosition" already IS "highest priority" for that pool;
 * there's no need to re-run compareCandidates() here. After promotion,
 * every remaining Waitlisted row in that pool with a WaitlistPosition
 * greater than the promoted student's old one shifts down by 1, so
 * positions stay contiguous from 1 (no gaps) — runAllocation.js's own
 * `waitlistStart` for a later run is computed from the highest surviving
 * WaitlistPosition in the pool, so a gap left here would silently waste a
 * number forever.
 * ============================================================================
 */

const { getSheetRows, writeRowAt, logEvent } = require('../_lib/sheets');
const { SHEET_NAMES, APPLICATIONS_COLUMNS, ROOM_INVENTORY_COLUMNS } = require('../_lib/schema');
const { requireAdmin } = require('../_lib/adminAuth');
const { generateAllotmentPDF } = require('../_lib/pdf');
const { sendAllotmentEmail } = require('../_lib/mailer');

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

    const writes = [];

    // ---- Vacate the student's own row ----
    const vacatedRow = { ...student, AllotmentStatus: 'Vacated', AllottedRoomNo: '' };
    writes.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, student._row, vacatedRow));

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

    // ---- Auto-promote the top of that pool's waitlist, if any ----
    const poolWaitlist = applicationRows
      .filter((r) =>
        r.ApplicationID !== applicationId &&
        r.HostelChoice === hostel &&
        r.RoomTypePreference === roomType &&
        r.AllotmentStatus === 'Waitlisted' &&
        Number(r.WaitlistPosition) > 0
      )
      .sort((a, b) => Number(a.WaitlistPosition) - Number(b.WaitlistPosition));

    let promoted = null;
    // Decrement now; if a promotion happens below, increment back — net zero
    // across the pair of writes (one room row, written once with the final
    // value), net -1 if the pool's waitlist was empty.
    let newOccupied = Math.max(0, Number(roomRow.Occupied || 0) - 1);

    if (poolWaitlist.length > 0) {
      const promotee = poolWaitlist[0];
      const promoteeOldPosition = Number(promotee.WaitlistPosition);

      const promotedRow = { ...promotee, AllotmentStatus: 'Allotted', AllottedRoomNo: oldRoomNo, WaitlistPosition: '' };
      writes.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, promotee._row, promotedRow));

      poolWaitlist.slice(1).forEach((r) => {
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

    writes.push(writeRowAt(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS, roomRow._row, { ...roomRow, Occupied: newOccupied }));

    await Promise.all(writes);

    res.status(200).json({
      success: true,
      vacated: { applicationId: student.ApplicationID, enrolmentNo: student.EnrolmentNo, name: student.Name, roomNo: oldRoomNo },
      roommateCleared,
      promoted,
      room: { roomNo: oldRoomNo, hostel, roomType, capacity: Number(roomRow.Capacity || 0), occupied: newOccupied }
    });
  } catch (err) {
    console.error('vacateRoom handler error:', err);
    await logEvent('vacateRoom', err.message, applicationId);
    res.status(500).json({ success: false, error: 'Something went wrong vacating this room. Please try again.' });
  }
};
