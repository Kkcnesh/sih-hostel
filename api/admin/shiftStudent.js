/**
 * ============================================================================
 * POST /api/admin/shiftStudent
 * ============================================================================
 * Manually moves an already-Allotted student into a different room —
 * RESTRICTED to a room within the exact same Hostel+RoomType pool as their
 * current room. This is a hard restriction, not a soft warning: shifting
 * across hostel or room type through this endpoint would bypass gender
 * segregation (Hostel is derived from Eligibility.Gender — see
 * _lib/schema.js's deriveHostelFromGender()) and the student's stated
 * RoomTypePreference, both of which the allocation engine itself protects.
 * Admin-only (see _lib/adminAuth.js).
 *
 * Request body: { applicationId, newRoomNo }
 *
 * ROOMMATE HANDLING: if the student has a live, mutually-confirmed paired
 * roommate (AllottedRoommateEnrolmentNo on both sides), the pair is moved
 * together IF AND ONLY IF the target room has 2 free seats *before* the
 * move; otherwise the pairing is broken (both sides'
 * AllottedRoommateEnrolmentNo cleared) and the response flags this via
 * `roommate.pairingBroken` so the admin isn't left assuming the roommate
 * silently followed.
 *
 * NOTIFICATION: sends a distinct "Room Reassignment" email (see
 * _lib/mailer.js's sendRoomChangeEmail) with a freshly generated allotment
 * PDF reflecting the NEW room — never sendAllotmentEmail()'s "Allotment
 * Confirmed" subject, which would misleadingly re-announce a room the
 * student already has. Single-recipient rule applies (the shifted student's
 * own email only) — a roommate moved along is not separately emailed by
 * this endpoint, matching this pass's explicitly single-student scope.
 * ============================================================================
 */

const { getSheetRows, writeRowAt, logEvent } = require('../_lib/sheets');
const { SHEET_NAMES, APPLICATIONS_COLUMNS, ROOM_INVENTORY_COLUMNS } = require('../_lib/schema');
const { requireAdmin } = require('../_lib/adminAuth');
const { generateAllotmentPDF } = require('../_lib/pdf');
const { sendRoomChangeEmail } = require('../_lib/mailer');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  if (!requireAdmin(req, res)) return;

  const { applicationId, newRoomNo } = req.body || {};
  if (!applicationId || typeof applicationId !== 'string') {
    res.status(400).json({ success: false, error: 'Missing or invalid applicationId.' });
    return;
  }
  if (!newRoomNo || typeof newRoomNo !== 'string') {
    res.status(400).json({ success: false, error: 'Missing or invalid newRoomNo.' });
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
        error: `Cannot shift — this application's status is "${student.AllotmentStatus}", not "Allotted".`
      });
      return;
    }

    const oldRoomNo = student.AllottedRoomNo;
    const hostel = student.HostelChoice;
    const roomType = student.RoomTypePreference;

    const newRoomRow = roomRows.find((r) => r.RoomNo === newRoomNo);
    if (!newRoomRow) {
      res.status(400).json({ success: false, error: `Room "${newRoomNo}" was not found in RoomInventory.` });
      return;
    }
    if (newRoomNo === oldRoomNo) {
      res.status(400).json({ success: false, error: `Student is already in room ${oldRoomNo} — nothing to shift.` });
      return;
    }
    if (newRoomRow.Hostel !== hostel || newRoomRow.RoomType !== roomType) {
      res.status(400).json({
        success: false,
        error: `Room ${newRoomNo} is ${newRoomRow.Hostel} / ${newRoomRow.RoomType} — can only shift within the student's own pool (${hostel} / ${roomType}).`
      });
      return;
    }

    const newRoomCapacity = Number(newRoomRow.Capacity || 0);
    const newRoomOccupied = Number(newRoomRow.Occupied || 0);
    const newRoomFree = newRoomCapacity - newRoomOccupied;
    if (newRoomFree <= 0) {
      res.status(400).json({ success: false, error: `Room ${newRoomNo} is already full (${newRoomOccupied}/${newRoomCapacity}).` });
      return;
    }

    const oldRoomRow = roomRows.find((r) => r.RoomNo === oldRoomNo);
    if (!oldRoomRow) {
      const message = `Application ${applicationId} is allotted to room "${oldRoomNo}", but that room was not found in RoomInventory.`;
      await logEvent('shiftStudent', message, student.EnrolmentNo);
      res.status(500).json({ success: false, error: message });
      return;
    }

    // ---- Roommate pairing decision ----
    // Only a MUTUALLY-confirmed pair (both sides point at each other) is
    // treated as "live" here — same mutuality discipline as vacateRoom.js,
    // so a pre-existing data inconsistency elsewhere is never silently
    // trusted or "corrected" as a side effect of this endpoint.
    const roommateEnrolment = String(student.AllottedRoommateEnrolmentNo || '').trim();
    let roommateRow = null;
    if (roommateEnrolment) {
      const candidate = applicationRows.find((r) => r.EnrolmentNo === roommateEnrolment && r.AllotmentStatus === 'Allotted');
      if (candidate && String(candidate.AllottedRoommateEnrolmentNo || '').trim() === student.EnrolmentNo) {
        roommateRow = candidate;
      }
    }

    const movingTogether = !!roommateRow && newRoomFree >= 2;
    const seatsToMove = movingTogether ? 2 : 1;

    const writes = [];
    const updatedStudentRow = { ...student, AllottedRoomNo: newRoomNo };
    let roommateResult = null;

    if (roommateRow && movingTogether) {
      const updatedRoommateRow = { ...roommateRow, AllottedRoomNo: newRoomNo };
      writes.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, roommateRow._row, updatedRoommateRow));
      roommateResult = { enrolmentNo: roommateRow.EnrolmentNo, name: roommateRow.Name, movedTogether: true, pairingBroken: false };
    } else if (roommateRow && !movingTogether) {
      updatedStudentRow.AllottedRoommateEnrolmentNo = '';
      writes.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, roommateRow._row, { ...roommateRow, AllottedRoommateEnrolmentNo: '' }));
      roommateResult = { enrolmentNo: roommateRow.EnrolmentNo, name: roommateRow.Name, movedTogether: false, pairingBroken: true };
    }

    writes.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, student._row, updatedStudentRow));

    const finalOldOccupied = Math.max(0, Number(oldRoomRow.Occupied || 0) - seatsToMove);
    const finalNewOccupied = newRoomOccupied + seatsToMove;
    writes.push(writeRowAt(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS, oldRoomRow._row, { ...oldRoomRow, Occupied: finalOldOccupied }));
    writes.push(writeRowAt(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS, newRoomRow._row, { ...newRoomRow, Occupied: finalNewOccupied }));

    writes.push(
      generateAllotmentPDF(updatedStudentRow, {
        hostel,
        roomType,
        roomNo: newRoomNo,
        roommateName: movingTogether ? roommateRow.Name : ''
      })
        .then((pdfBuffer) => sendRoomChangeEmail(updatedStudentRow, pdfBuffer, { oldRoomNo, newRoomNo }))
        .catch((err) => logEvent('shiftStudent', `Room-change email failed for ${student.EnrolmentNo}: ${err.message}`, student.EnrolmentNo))
    );

    await Promise.all(writes);

    res.status(200).json({
      success: true,
      applicationId: student.ApplicationID,
      enrolmentNo: student.EnrolmentNo,
      hostel,
      roomType,
      oldRoomNo,
      newRoomNo,
      roommate: roommateResult,
      rooms: {
        old: { roomNo: oldRoomNo, capacity: Number(oldRoomRow.Capacity || 0), occupied: finalOldOccupied },
        new: { roomNo: newRoomNo, capacity: newRoomCapacity, occupied: finalNewOccupied }
      }
    });
  } catch (err) {
    console.error('shiftStudent handler error:', err);
    await logEvent('shiftStudent', err.message, applicationId);
    res.status(500).json({ success: false, error: 'Something went wrong shifting this student. Please try again.' });
  }
};
