/**
 * ============================================================================
 * POST /api/getApplicationStatus
 * ============================================================================
 * Ported from Code.gs's getApplicationStatus(enrolmentNo). Same response
 * shape: {success, application:{...}} or {success:false, error}. Reads the
 * student's Applications row and resolves each Drive link back to a real
 * filename for the documents checklist — see status.html for the exact
 * fields it reads off `application`.
 * ============================================================================
 */

const { getSheetRows, logEvent } = require('./_lib/sheets');
const { getFileNameFromDriveLink } = require('./_lib/drive');
const {
  SHEET_NAMES,
  APPLICATIONS_COLUMNS,
  DOC_TYPE_COLUMNS,
  SERVER_TO_CLIENT_DOC_KEY,
  splitDriveLinks
} = require('./_lib/schema');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const result = await getApplicationStatus((req.body || {}).enrolmentNo);
    res.status(200).json(result);
  } catch (err) {
    console.error('getApplicationStatus handler error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

async function getApplicationStatus(enrolmentNo) {
  enrolmentNo = String(enrolmentNo || '').trim();
  try {
    const applicationRows = await getSheetRows(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS);
    const record = applicationRows.find((row) => String(row.EnrolmentNo).trim() === enrolmentNo);
    if (!record) {
      return { success: false, error: 'No application found for this student yet.' };
    }

    const documents = {};
    for (const docType of Object.keys(DOC_TYPE_COLUMNS)) {
      const clientKey = SERVER_TO_CLIENT_DOC_KEY[docType];
      documents[clientKey] = await docEntryFromLink(record[DOC_TYPE_COLUMNS[docType]]);
    }

    return {
      success: true,
      application: {
        applicationId: record.ApplicationID,
        submittedDate: record.SubmissionTimestamp,
        verificationStatus: record.VerificationStatus,
        allotmentStatus: record.AllotmentStatus,
        hostel: record.HostelChoice,
        allottedRoomNo: record.AllottedRoomNo,
        allottedRoommateEnrolmentNo: record.AllottedRoommateEnrolmentNo,
        waitlistPosition: record.WaitlistPosition,
        documents
      }
    };
  } catch (err) {
    await logEvent('getApplicationStatus', err.message, enrolmentNo);
    return { success: false, error: 'Something went wrong loading your application status.' };
  }
}

/** One Applications cell can hold a single Drive link or a comma-joined list (Marksheets) — normalize both into a {done, files} entry, resolving real filenames from Drive. */
async function docEntryFromLink(rawLink) {
  const links = splitDriveLinks(rawLink);
  if (links.length === 0) return { done: false, files: [] };

  const files = await Promise.all(
    links.map(async (url) => ({
      name: (await getFileNameFromDriveLink(url)) || 'Uploaded document',
      size: 0
    }))
  );
  return { done: true, files };
}
