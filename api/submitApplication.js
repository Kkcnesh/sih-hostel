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
 * School/HostelChoice) are re-read from Eligibility here rather than
 * trusted from the client, same as before — HostelChoice specifically is
 * derived from Gender (deriveHostelFromGender() in _lib/schema.js) and,
 * unlike the others, rejects the whole submission outright if Gender
 * doesn't map cleanly, rather than substituting anything.
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
  deriveHostelFromGender,
  buildApplicationRow
} = require('./_lib/schema');
const { generateApplicationPDF } = require('./_lib/pdf');
const { sendApplicationConfirmationEmail } = require('./_lib/mailer');

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

    // HostelChoice is enforced here, not just in the UI — a direct API
    // call can send any HostelChoice it likes; buildApplicationRow()
    // below ignores it completely and re-derives from elig.Gender instead
    // (same pattern as Name/DOB/Course/School). This is the one case
    // where an unmappable value must reject the whole submission rather
    // than silently substitute something — see deriveHostelFromGender()'s
    // doc comment in _lib/schema.js for why guessing here would be worse
    // than failing loudly.
    if (!deriveHostelFromGender(elig.Gender)) {
      return { success: false, error: `Your Gender on record ("${elig.Gender || 'blank'}") doesn't map to a hostel. Contact the Hostel Office to have your Eligibility record corrected before applying.` };
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

    // Confirmation email is a best-effort side effect, generated/sent AFTER
    // the sheet write above has already succeeded — wrapped in its own
    // try/catch so a PDF or Gmail failure can never turn this response into
    // success:false (the application is already saved regardless).
    // Deliberately AWAITED rather than fire-and-forget: a plain Vercel
    // serverless function (this style, not an Edge Function) has no
    // guaranteed background execution once res.json() below sends the
    // response — an un-awaited send risks the function being frozen
    // mid-request and the email silently never going out. mailer.js's own
    // internal try/catch means a failure here already resolves to `false`
    // rather than throwing; this outer try/catch only guards generateApplicationPDF().
    try {
      const pdfBuffer = await generateApplicationPDF(rowObject);
      await sendApplicationConfirmationEmail(rowObject, pdfBuffer);
    } catch (err) {
      await logEvent('submitApplication', `Confirmation email failed: ${err.message}`, enrolmentNo);
    }

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
