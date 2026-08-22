/**
 * ============================================================================
 * POST /api/submitApplication
 * ============================================================================
 * Ported from Code.gs's submitApplication(formData). Same response shape:
 * {success, applicationId} or {success:false, error} or
 * {success:false, errors}. Writes one row to Applications per student — if
 * a Pending row already exists for this EnrolmentNo it's updated in place
 * (edit-before-verification is allowed) and keeps its original
 * ApplicationID; once VerificationStatus moves past "Pending" the row is
 * locked and resubmission is rejected. Identity fields (Name/DOB/Course/
 * School) are re-read from Eligibility here rather than trusted from the
 * client, same as before.
 *
 * KNOWN LIMITATION — race condition, flagged rather than silently dropped:
 * Code.gs used LockService.getScriptLock() to make the whole "check
 * existing row -> decide insert/update -> generate ApplicationID -> write"
 * sequence atomic across concurrent requests. Vercel Serverless Functions
 * have no equivalent: each invocation can run in its own isolated
 * container with no shared in-process mutex, and the Sheets API has no
 * compare-and-swap / conditional-write primitive to build a true atomic
 * increment on top of. What's below is a plain read-increment-write on the
 * Counters sheet — safe under normal traffic, but if two submissions from
 * *different* students land in the same few hundred milliseconds, they
 * could theoretically read the same counter value before either writes it
 * back, producing two rows with the same ApplicationID. At hackathon/
 * pilot scale this is unlikely to matter; if it ever does, replace the
 * counter with a real atomic-increment store (Vercel KV, Firestore, a
 * small Redis) rather than trying to simulate a lock on top of Sheets.
 * ============================================================================
 */

const { getSheetRows, writeRowAt, writeCell, logEvent } = require('./_lib/sheets');
const {
  SHEET_NAMES,
  ELIGIBILITY_COLUMNS,
  APPLICATIONS_COLUMNS,
  COUNTERS_COLUMNS,
  validateApplicationFields,
  buildApplicationRow
} = require('./_lib/schema');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const result = await submitApplication(req.body || {});
    res.status(200).json(result);
  } catch (err) {
    console.error('submitApplication handler error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

async function submitApplication(formData) {
  const enrolmentNo = String((formData && formData.enrolmentNo) || '').trim();
  try {
    if (!enrolmentNo) return { success: false, error: 'Missing enrolment number.' };

    const eligibilityRows = await getSheetRows(SHEET_NAMES.ELIGIBILITY, ELIGIBILITY_COLUMNS);
    const elig = eligibilityRows.find((row) => String(row.EnrolmentNo).trim() === enrolmentNo);
    if (!elig) {
      return { success: false, error: 'This enrolment number is not on the eligibility list. Contact the Hostel Office.' };
    }

    const errors = validateApplicationFields(formData);
    if (Object.keys(errors).length > 0) {
      return { success: false, errors };
    }

    // See the KNOWN LIMITATION note above — this check-then-write sequence
    // (existing-row lookup through the final writeRowAt call) is NOT
    // protected by a lock the way Code.gs's version was.
    const applicationRows = await getSheetRows(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS);
    const existing = applicationRows.find((row) => String(row.EnrolmentNo).trim() === enrolmentNo);

    let applicationId;
    let targetRow;
    if (existing) {
      if (existing.VerificationStatus !== 'Pending') {
        return { success: false, error: 'Your application has already been verified and can no longer be edited here. Contact the Hostel Office for changes.' };
      }
      applicationId = existing.ApplicationID;
      targetRow = existing._row;
    } else {
      applicationId = await generateApplicationId();
      targetRow = applicationRows.length > 0
        ? applicationRows[applicationRows.length - 1]._row + 1
        : 2; // first data row, right after the header
    }

    const rowObject = buildApplicationRow(formData, elig, applicationId);
    await writeRowAt(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS, targetRow, rowObject);

    return { success: true, applicationId };
  } catch (err) {
    await logEvent('submitApplication', err.message, enrolmentNo);
    return { success: false, error: 'Something went wrong submitting your application. Please try again.' };
  }
}

/** Zero-padded, year-scoped application reference — e.g. HA-2026-000123. See the KNOWN LIMITATION note at the top of this file. */
async function generateApplicationId() {
  const counterRows = await getSheetRows(SHEET_NAMES.COUNTERS, COUNTERS_COLUMNS);
  const counterRow = counterRows.find((row) => row.CounterName === 'ApplicationID');
  if (!counterRow) {
    throw new Error('Counters sheet has no "ApplicationID" row — run the setup steps in SETUP.md.');
  }

  const nextValue = Number(counterRow.NextValue || 0) + 1;
  await writeCell(SHEET_NAMES.COUNTERS, `B${counterRow._row}`, nextValue);

  const year = new Date().getFullYear();
  return `HA-${year}-${String(nextValue).padStart(6, '0')}`;
}
