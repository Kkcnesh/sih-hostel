/**
 * ============================================================================
 * POST /api/uploadDocument
 * ============================================================================
 * Ported from Code.gs's uploadDocument(enrolmentNo, docType, base64Data,
 * fileName, mimeType). Same response shape: {success, fileUrl, fileId} or
 * {success:false, error}. Decodes one base64-encoded file and drops it into
 * "Hostel Applications/<EnrolmentNo>/" in Drive — same per-file, per-call
 * contract as before (the client still loops this once per file for
 * multi-file uploads like Marksheets and joins the returned links itself;
 * see js/script.js's uploader component).
 * ============================================================================
 */

const { logEvent } = require('./_lib/sheets');
const { getOrCreateStudentFolder, uploadFile } = require('./_lib/drive');
const { DOC_TYPE_COLUMNS, MAX_UPLOAD_BYTES, ALLOWED_MIME_TYPES } = require('./_lib/schema');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const result = await uploadDocument(req.body || {});
    res.status(200).json(result);
  } catch (err) {
    console.error('uploadDocument handler error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

async function uploadDocument({ enrolmentNo, docType, base64Data, fileName, mimeType }) {
  try {
    enrolmentNo = String(enrolmentNo || '').trim();
    if (!enrolmentNo) return { success: false, error: 'Missing enrolment number.' };
    if (!Object.prototype.hasOwnProperty.call(DOC_TYPE_COLUMNS, docType)) {
      return { success: false, error: `Unknown document type "${docType}".` };
    }
    if (ALLOWED_MIME_TYPES.indexOf(mimeType) === -1) {
      return { success: false, error: 'Only JPG, PNG or PDF files are accepted.' };
    }

    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch (decodeErr) {
      return { success: false, error: 'That file could not be read. Please try selecting it again.' };
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return { success: false, error: 'File is over 5 MB — choose a smaller file.' };
    }

    const folderId = await getOrCreateStudentFolder(enrolmentNo);
    const { fileId, fileUrl } = await uploadFile({ folderId, fileName, mimeType, buffer });
    // Never made public — see the header note in _lib/drive.js.

    return { success: true, fileUrl, fileId };
  } catch (err) {
    await logEvent('uploadDocument', `${docType}: ${err.message}`, enrolmentNo);
    return { success: false, error: 'Something went wrong uploading that file. Please try again.' };
  }
}
