/**
 * ============================================================================
 * POST /api/runAllocation
 * ============================================================================
 * Admin-only, API-only endpoint (no UI yet — call it with curl/Postman).
 * Assigns every "Not Processed" Applications row a room or a waitlist
 * position, using the priority policy implemented in _lib/allocation.js —
 * see the long comment at the top of that file for exactly which tiers are
 * implemented and why (short version: a deliberately scoped-down 3-tier
 * version of GGSIPU's real 7-tier policy — flagged and decided on
 * 2026-08-22 rather than guessed at silently. Distance-from-residence is
 * now collected and used as an intra-tier tiebreaker as of 2026-08-24, but
 * the NCR sub-region / govt-transfer distinctions the real 7-tier structure
 * itself needs still aren't).
 *
 * AUTH: shared-secret only (Authorization: Bearer <ADMIN_SECRET>). There's
 * no admin login system yet, so this is intentionally the simplest thing
 * that isn't "wide open" — set ADMIN_SECRET in Vercel and share it only
 * with whoever runs allocations. See SETUP.md.
 *
 * VERIFICATION GATING (added 2026-08-24): a candidate must have BOTH
 * AllotmentStatus === "Not Processed" AND VerificationStatus === "Verified"
 * to be processed this run. An unverified "Not Processed" row is simply
 * left alone — still "Not Processed", not "Waitlisted" — a student who
 * hasn't been verified yet hasn't been rejected, they just haven't been
 * reached; conflating the two would misreport "no seat available" for
 * someone the admin hasn't even looked at. This was a deliberately
 * unimplemented open question in an earlier pass (rooms were being
 * allocated to unverified applicants) — see admin/vacateRoom.js's
 * auto-promotion for the same gating applied on that path.
 *
 * IDEMPOTENCY / "FIRST-RUN LOCKS IN" — read before relying on this for a
 * real multi-round admissions cycle:
 * Only rows with AllotmentStatus === "Not Processed" (and, as of the
 * verification gating above, VerificationStatus === "Verified") are read
 * as candidates, and RoomInventory's Occupied counts (read fresh every run)
 * already reflect every previous run's allotments — so running this again
 * after new applications arrive allocates the *new* rows into whatever
 * capacity is left, without touching or re-ranking anyone already
 * Allotted/Waitlisted. That also means allocation is NOT globally
 * re-optimized each run: a low-priority student processed in an early run
 * (before a higher-priority student applies later) keeps their seat even
 * though a strict single-pass-over-everyone run would have ranked the
 * latecomer above them. For a hackathon demo this is the simpler, more
 * predictable behavior (nobody's already-confirmed room ever gets taken
 * away by a later run) — flagged per the spec's own request in case a real
 * multi-round admissions process would actually want live re-optimization
 * instead; that would be a different, more disruptive design (re-reading
 * and re-deciding EVERY row, including previously-Allotted ones, each run).
 *
 * WAITLIST NUMBERING ACROSS RUNS: a previously-waitlisted row's
 * WaitlistPosition is never renumbered (that would be "touching" a past
 * run's result). So each pool's new run continues numbering after the
 * highest WaitlistPosition already on the sheet for that pool, rather than
 * restarting at 1 — otherwise two different applicants could end up with
 * the same WaitlistPosition in the same pool.
 * ============================================================================
 */

const { getSheetRows, writeRowAt, logEvent } = require('./_lib/sheets');
const { SHEET_NAMES, APPLICATIONS_COLUMNS, ROOM_INVENTORY_COLUMNS } = require('./_lib/schema');
const { HOSTELS, ROOM_TYPES, compareCandidates, allocatePool } = require('./_lib/allocation');
const { requireAdmin } = require('./_lib/adminAuth');
const { generateAllotmentPDF } = require('./_lib/pdf');
const { sendAllotmentEmail } = require('./_lib/mailer');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  if (!requireAdmin(req, res)) return; // requireAdmin already sent the 401/500 response

  try {
    const result = await runAllocation();
    res.status(200).json(result);
  } catch (err) {
    console.error('runAllocation handler error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong running the allocation. Please try again.' });
  }
};

async function runAllocation() {
  try {
    const [applicationRows, roomRows] = await Promise.all([
      getSheetRows(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS),
      getSheetRows(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS)
    ]);

    const candidates = applicationRows.filter((row) => row.AllotmentStatus === 'Not Processed' && row.VerificationStatus === 'Verified');

    const pools = [];
    const warnings = [];
    const applicationWrites = [];
    const roomWrites = [];
    const emailSends = [];
    const allResults = [];

    for (const hostel of HOSTELS) {
      for (const roomType of ROOM_TYPES) {
        const poolCandidates = candidates.filter((c) => c.HostelChoice === hostel && c.RoomTypePreference === roomType);
        const ranked = [...poolCandidates].sort(compareCandidates);

        const poolRooms = roomRows
          .filter((r) => r.Hostel === hostel && r.RoomType === roomType)
          .map((r) => ({
            RoomNo: r.RoomNo,
            remaining: Math.max(0, Number(r.Capacity || 0) - Number(r.Occupied || 0)),
            _sourceRow: r
          }));

        // Previously-waitlisted rows for this exact pool (from any earlier
        // run, or rows already sitting in the sheet before this run) keep
        // their WaitlistPosition untouched — new waitlist entries continue
        // numbering after the highest one already used, see file header.
        const existingWaitlistPositions = applicationRows
          .filter((r) => r.HostelChoice === hostel && r.RoomTypePreference === roomType && r.AllotmentStatus === 'Waitlisted')
          .map((r) => Number(r.WaitlistPosition) || 0);
        const waitlistStart = (existingWaitlistPositions.length ? Math.max(...existingWaitlistPositions) : 0) + 1;

        const { results, rooms: finalRooms } = allocatePool(ranked, poolRooms, waitlistStart);

        results.forEach((result) => {
          const candidateRow = ranked.find((c) => c.EnrolmentNo === result.enrolmentNo);
          const updatedRow = {
            ...candidateRow,
            AllotmentStatus: result.status,
            AllottedRoomNo: result.roomNo || '',
            AllottedRoommateEnrolmentNo: result.roommateEnrolmentNo || '',
            WaitlistPosition: result.waitlistPosition != null ? result.waitlistPosition : ''
          };
          applicationWrites.push(writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, candidateRow._row, updatedRow));

          // Allotment email — only for rows THIS run newly moved to
          // "Allotted" (every row in `results` was "Not Processed" before
          // this run, per the `candidates` filter above, so `status ===
          // 'Allotted'` here always means "newly allotted just now", never
          // a previously-allotted row). Waitlisted candidates get no email
          // (not asked for). Best-effort: sendAllotmentEmail() never
          // throws (see mailer.js), and a PDF-generation failure is caught
          // here so it can't affect applicationWrites/roomWrites below.
          if (result.status === 'Allotted') {
            const roommateName = result.roommateEnrolmentNo
              ? (ranked.find((c) => c.EnrolmentNo === result.roommateEnrolmentNo) || {}).Name || ''
              : '';
            emailSends.push(
              generateAllotmentPDF(updatedRow, { hostel, roomType, roomNo: result.roomNo, roommateName })
                .then((pdfBuffer) => sendAllotmentEmail(updatedRow, pdfBuffer))
                .catch((err) => logEvent('runAllocation', `Allotment email failed for ${result.enrolmentNo}: ${err.message}`, result.enrolmentNo))
            );
          }

          allResults.push({
            enrolmentNo: result.enrolmentNo,
            name: candidateRow.Name,
            hostel,
            roomType,
            tier: result.tier,
            status: result.status,
            roomNo: result.roomNo,
            roommateEnrolmentNo: result.roommateEnrolmentNo || null,
            waitlistPosition: result.waitlistPosition,
            note: result.note || undefined
          });
        });

        // Only write RoomInventory rows whose Occupied count actually
        // changed this run — no reason to touch rooms nobody was seated in.
        finalRooms.forEach((room) => {
          const original = room._sourceRow;
          const newOccupied = Number(original.Capacity || 0) - room.remaining;
          if (newOccupied !== Number(original.Occupied || 0)) {
            const updatedRoomRow = { ...original, Occupied: newOccupied };
            roomWrites.push(writeRowAt(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS, original._row, updatedRoomRow));
          }
        });

        pools.push({
          hostel,
          roomType,
          candidatesProcessed: ranked.length,
          allotted: results.filter((r) => r.status === 'Allotted').length,
          waitlisted: results.filter((r) => r.status === 'Waitlisted').length
        });
      }
    }

    // Candidates whose HostelChoice/RoomTypePreference don't match one of
    // the 4 known pools (shouldn't happen via the wizard's radio buttons,
    // but the sheet can be hand-edited) are deliberately left untouched —
    // still "Not Processed", surfaced here rather than silently skipped or
    // guessed into a pool.
    const knownPoolKeys = new Set(HOSTELS.flatMap((h) => ROOM_TYPES.map((rt) => `${h}|${rt}`)));
    candidates
      .filter((c) => !knownPoolKeys.has(`${c.HostelChoice}|${c.RoomTypePreference}`))
      .forEach((c) => warnings.push(`${c.EnrolmentNo}: unrecognized HostelChoice/RoomTypePreference combo ("${c.HostelChoice}" / "${c.RoomTypePreference}") — left as Not Processed.`));

    // emailSends is included here (not fired-and-forgotten) for the same
    // reason submitApplication.js awaits its confirmation email — a Vercel
    // serverless function has no guaranteed background execution after the
    // response is sent. Every promise in emailSends already resolves
    // (never rejects) even on failure, so this can't turn a successful
    // allocation run into an error response.
    await Promise.all([...applicationWrites, ...roomWrites, ...emailSends]);

    return {
      success: true,
      policyNote: 'Scoped-down 3-tier priority order (PwBD > non-Delhi residence > Delhi); within each tier, farther self-declared DistanceFromResidenceKm wins, then earlier submission time — see the comment at the top of _lib/allocation.js for why the full 7-tier GGSIPU policy (which also splits by NCR sub-region and govt-transfer status) isn\'t implemented yet.',
      summary: {
        totalCandidates: candidates.length,
        totalAllotted: allResults.filter((r) => r.status === 'Allotted').length,
        totalWaitlisted: allResults.filter((r) => r.status === 'Waitlisted').length,
        pools
      },
      results: allResults,
      warnings
    };
  } catch (err) {
    await logEvent('runAllocation', err.message, '');
    return { success: false, error: 'Something went wrong running the allocation. Please try again.' };
  }
}
