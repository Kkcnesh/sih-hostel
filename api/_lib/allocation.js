/**
 * ============================================================================
 * HOSTEL SEAT ALLOCATION — PURE LOGIC (no network calls in this file)
 * ============================================================================
 * All the actual "who gets which room" decision-making lives here, kept
 * free of any Sheets/Drive I/O so it can be unit-tested with plain JS
 * objects (see the pattern schema.js already uses for validateApplicationFields
 * etc.). api/runAllocation.js is the thin handler: it does auth, reads
 * Applications/RoomInventory, calls into this file, and writes the result
 * back. If you're debugging a "wrong room" or "wrong tier" bug, the answer
 * is almost certainly in here, not in runAllocation.js.
 *
 * ----------------------------------------------------------------------------
 * POLICY IMPLEMENTED — a deliberately SCOPED-DOWN version of the real one
 * ----------------------------------------------------------------------------
 * GGSIPU's actual "Policy for Allotment of Hostel Seat" (East Delhi Campus
 * Boys Hostel Admission Brochure) is a 7-tier order:
 *   1. PwBD (benchmark disability)
 *   2. Outside Delhi-NCR, ranked by distance from residence to EDC
 *   3. Govt-transferred outside Delhi-NCR
 *   4. Outside Delhi (within NCR), ranked by distance
 *   5. Govt-transferred outside Delhi
 *   6. Delhi (NCT), ranked by distance
 *   7. (unallotted -> waitlist, same relative order)
 *
 * The application form/schema does NOT currently collect what tiers 2-6
 * need to be told apart:
 *   - CategoryResidence only has 3 values (Delhi / Outside Delhi /
 *     Transferred) — it can't distinguish "Outside Delhi-NCR" (tier 2) from
 *     "Outside Delhi but still within NCR" (tier 4), and "Transferred"
 *     doesn't say whether the transfer origin was outside NCR (tier 3) or
 *     just outside Delhi (tier 5).
 *   - There is no distance-from-residence field (or even a pincode/city to
 *     derive one from) anywhere in the 43-column Applications schema, so
 *     intra-tier distance ranking (tiers 2/4/6) isn't possible either.
 *
 * Per an explicit decision on 2026-08-22 (rather than inventing placeholder
 * distance data or silently dropping tiers), this implements a collapsed
 * 3-tier version using only what's actually collected:
 *   1. PwBD          — CategoryReservation === 'PH' (the only disability-
 *                       adjacent value in the schema; see the note on
 *                       priorityTier() below for a caveat on this mapping)
 *   2. Non-Delhi      — CategoryResidence !== 'Delhi' (i.e. "Outside Delhi"
 *                       and "Transferred" combined — they can't be told
 *                       apart or distance-ranked with current data)
 *   3. Delhi          — CategoryResidence === 'Delhi'
 * Within each tier: earlier SubmissionTimestamp wins (ties broken further
 * by EnrolmentNo for full determinism).
 *
 * To upgrade to the real 7-tier policy later: add a DistanceFromResidence
 * (or residence pincode) field to the application form + schema, split the
 * category radio into the 5 real residence buckets, then rewrite
 * priorityTier()/compareCandidates() below — allocatePool() itself doesn't
 * need to change, since it just consumes whatever order it's given.
 * ============================================================================
 */

const HOSTELS = ['Boys', 'Girls'];
const ROOM_TYPES = ['Triple-sharing', '4-sharing'];

/**
 * 1 = PwBD, 2 = non-Delhi residence, 3 = Delhi. Lower number = higher priority.
 *
 * CAVEAT (flagged, not silently assumed): CategoryReservation (GEN/SC/ST/OBC/
 * EWS/PWD) is modeled as one mutually-exclusive field, but in real Indian
 * reservation policy PwBD/disability is a *horizontal* reservation that cuts
 * across vertical caste categories — a student can be SC *and* PwBD at once.
 * This schema can't represent that (a PwBD+SC student has to pick one
 * value), so treating CategoryReservation === 'PWD' as "the" PwBD signal may
 * undercount real PwBD applicants. Pre-existing schema limitation, not
 * something this function can fix on its own.
 *
 * NAMING: this value was 'PH' until the 2026-08-23 UI redesign renamed it
 * to 'PWD'. EWS/OBC are new alongside it but need no tiering logic of their
 * own — only PWD status and CategoryResidence matter for this collapsed
 * 3-tier policy (see the file header comment).
 */
function priorityTier(candidate) {
  if (String(candidate.CategoryReservation || '').trim().toUpperCase() === 'PWD') return 1;
  if (String(candidate.CategoryResidence || '').trim() !== 'Delhi') return 2;
  return 3;
}

/** Sort comparator: tier, then SubmissionTimestamp (ISO strings sort chronologically as plain strings), then EnrolmentNo as a final deterministic tiebreak. */
function compareCandidates(a, b) {
  const tierDiff = priorityTier(a) - priorityTier(b);
  if (tierDiff !== 0) return tierDiff;
  const timeDiff = String(a.SubmissionTimestamp || '').localeCompare(String(b.SubmissionTimestamp || ''));
  if (timeDiff !== 0) return timeDiff;
  return String(a.EnrolmentNo || '').localeCompare(String(b.EnrolmentNo || ''));
}

/** Natural sort (Room2 before Room10) so room-fill order is stable and human-sensible across reruns. */
function sortRoomsByRoomNo(rooms) {
  return [...rooms].sort((a, b) =>
    String(a.RoomNo).localeCompare(String(b.RoomNo), undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * Fills seats for one (Hostel x RoomType) pool, in priority order, with a
 * roommate-pairing pass baked into the same single walk of the ranked list
 * (see the long comment inside the loop for exactly how that interacts with
 * priority order — the short version: pairing can only use seats that are
 * genuinely spare, never bump a higher-priority non-paired student).
 *
 * Pure function: takes plain data in, returns plain data out, mutates
 * nothing the caller passed in (rooms are shallow-copied internally).
 *
 * @param rankedCandidates - candidates for this pool, already sorted by compareCandidates()
 * @param rooms - [{RoomNo, remaining}], remaining = Capacity - Occupied at the start of this run
 * @param waitlistStart - 1-indexed WaitlistPosition to assign to the first newly-waitlisted candidate (see runAllocation.js for why this isn't always 1: previously-waitlisted rows from an earlier run keep their position, so a new run continues numbering after them rather than renumbering everyone)
 * @returns {{ results: Array, rooms: Array }} - results is parallel to rankedCandidates; rooms is the post-fill remaining-capacity state
 */
function allocatePool(rankedCandidates, rooms, waitlistStart) {
  const workingRooms = sortRoomsByRoomNo(rooms).map((r) => ({ ...r }));
  const firstRoomWithCapacity = (min) => workingRooms.find((r) => r.remaining >= min);

  const placed = new Map(); // EnrolmentNo -> { roomNo, roommateEnrolmentNo }
  const pairingNotes = new Map(); // EnrolmentNo -> note string, set on BOTH sides of a pair whose co-location failed
  const handled = new Set(); // EnrolmentNo already resolved this pass (either placed, or explicitly skipped as someone else's handled partner)

  for (const candidate of rankedCandidates) {
    if (handled.has(candidate.EnrolmentNo)) continue;
    handled.add(candidate.EnrolmentNo);

    const partnerEnrolment = String(candidate.RoommatePreferenceEnrolmentNo || '').trim();
    const partner = partnerEnrolment
      ? rankedCandidates.find((c) => c.EnrolmentNo === partnerEnrolment && !handled.has(c.EnrolmentNo))
      : null;
    const mutual = !!partner && String(partner.RoommatePreferenceEnrolmentNo || '').trim() === candidate.EnrolmentNo;

    if (mutual) {
      // Look for a room with 2 free seats FIRST — at this point in the walk,
      // by construction, nobody of higher priority than `candidate` has
      // been skipped over, so any capacity found here is genuinely spare
      // capacity, never a seat "borrowed" from a better-ranked single
      // applicant. This is what lets the lower-ranked partner potentially
      // join even if their own rank alone wouldn't have made the cutoff —
      // without ever bumping anyone.
      const pairRoom = firstRoomWithCapacity(2);
      if (pairRoom) {
        pairRoom.remaining -= 2;
        placed.set(candidate.EnrolmentNo, { roomNo: pairRoom.RoomNo, roommateEnrolmentNo: partner.EnrolmentNo });
        placed.set(partner.EnrolmentNo, { roomNo: pairRoom.RoomNo, roommateEnrolmentNo: candidate.EnrolmentNo });
        handled.add(partner.EnrolmentNo);
        continue;
      }

      // Can't seat them together. Seat the current candidate (the
      // better-ranked one, since we're walking in rank order) alone if any
      // single seat remains — they've earned it on their own merit
      // regardless of the pairing outcome. The partner is deliberately
      // NOT added to `handled` here: they fall back through to their own
      // normal turn later in this same loop, evaluated purely on their own
      // rank (may still get a solo seat, may be waitlisted) — exactly as
      // if they'd never expressed a preference, which is the correct
      // "don't let a low-priority pair jump ahead of a higher-priority
      // single applicant" behavior.
      const noteBoth = `Requested roommate could not be seated in the same room (insufficient joint capacity) — allocated individually.`;
      pairingNotes.set(candidate.EnrolmentNo, noteBoth);
      pairingNotes.set(partner.EnrolmentNo, noteBoth);

      const soloRoom = firstRoomWithCapacity(1);
      if (soloRoom) {
        soloRoom.remaining -= 1;
        placed.set(candidate.EnrolmentNo, { roomNo: soloRoom.RoomNo, roommateEnrolmentNo: '' });
      }
      continue;
    }

    // No live mutual pairing to honor (no preference, one-sided preference,
    // or partner already resolved) — plain single-seat fill.
    const room = firstRoomWithCapacity(1);
    if (room) {
      room.remaining -= 1;
      placed.set(candidate.EnrolmentNo, { roomNo: room.RoomNo, roommateEnrolmentNo: '' });
    }
  }

  let waitlistPosition = waitlistStart;
  const results = rankedCandidates.map((candidate) => {
    const note = pairingNotes.get(candidate.EnrolmentNo) || '';
    const placement = placed.get(candidate.EnrolmentNo);
    if (placement) {
      return {
        enrolmentNo: candidate.EnrolmentNo,
        tier: priorityTier(candidate),
        status: 'Allotted',
        roomNo: placement.roomNo,
        roommateEnrolmentNo: placement.roommateEnrolmentNo,
        waitlistPosition: null,
        note
      };
    }
    return {
      enrolmentNo: candidate.EnrolmentNo,
      tier: priorityTier(candidate),
      status: 'Waitlisted',
      roomNo: null,
      roommateEnrolmentNo: '',
      waitlistPosition: waitlistPosition++,
      note
    };
  });

  return { results, rooms: workingRooms };
}

module.exports = {
  HOSTELS,
  ROOM_TYPES,
  priorityTier,
  compareCandidates,
  sortRoomsByRoomNo,
  allocatePool
};
