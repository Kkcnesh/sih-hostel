/**
 * ============================================================================
 * POST /api/login
 * ============================================================================
 * Ported from Code.gs's loginStudent(enrolmentNo, dob). Same response
 * shape: {success, student, hasExistingApplication, applicationId} or
 * {success:false, error}. See js/script.js's login call site (index.html)
 * for the exact fields the client reads back — do not rename any of them
 * here without updating that call site too.
 * ============================================================================
 */

const { getSheetRows, logEvent } = require('./_lib/sheets');
const { SHEET_NAMES, ELIGIBILITY_COLUMNS, APPLICATIONS_COLUMNS, parseSheetDate } = require('./_lib/schema');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const result = await loginStudent(req.body || {});
    res.status(200).json(result);
  } catch (err) {
    console.error('login handler error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

async function loginStudent({ enrolmentNo, dob }) {
  try {
    enrolmentNo = String(enrolmentNo || '').trim();
    if (!enrolmentNo || !dob) {
      return { success: false, error: 'Enter both your enrolment number and date of birth.' };
    }

    const NOT_FOUND = { success: false, error: 'We couldn’t find a match for that enrolment number and date of birth. Double-check both and try again.' };

    const eligibilityRows = await getSheetRows(SHEET_NAMES.ELIGIBILITY, ELIGIBILITY_COLUMNS);
    const elig = eligibilityRows.find((row) => String(row.EnrolmentNo).trim() === enrolmentNo);
    if (!elig) return NOT_FOUND;

    // Format-tolerant comparison — see parseSheetDate()'s doc comment in
    // _lib/schema.js for why this can't be a raw string compare. Guard
    // against BOTH sides failing to parse and comparing null === null as
    // if that were a match — an unparseable date is always a non-match.
    const eligDob = parseSheetDate(elig.DOB);
    const inputDob = parseSheetDate(dob);
    if (!eligDob || !inputDob || eligDob !== inputDob) return NOT_FOUND;

    const applicationRows = await getSheetRows(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS);
    const existingApplication = applicationRows.find((row) => String(row.EnrolmentNo).trim() === enrolmentNo);

    return {
      success: true,
      student: {
        EnrolmentNo: enrolmentNo,
        Name: elig.Name,
        DOB: eligDob, // already parsed above, into a clean YYYY-MM-DD
        Course: elig.Course,
        School: elig.School,
        Gender: elig.Gender
      },
      hasExistingApplication: !!existingApplication,
      applicationId: existingApplication ? existingApplication.ApplicationID : null
    };
  } catch (err) {
    await logEvent('loginStudent', err.message, enrolmentNo);
    return { success: false, error: 'Something went wrong checking your details. Please try again.' };
  }
}
