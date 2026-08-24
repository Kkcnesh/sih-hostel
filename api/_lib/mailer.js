/**
 * ============================================================================
 * GMAIL SENDING — student-only notification emails with a PDF attached
 * ============================================================================
 * Sends through the Gmail API (`gmail.users.messages.send`), authenticated
 * with the exact same OAuth2 client/refresh-token pattern as
 * _lib/sheets.js's getAuth() (same GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/
 * GOOGLE_REFRESH_TOKEN env vars — no separate credential set for email).
 *
 * IMPORTANT — SCOPE CHANGE, READ THIS BEFORE DEPLOYING:
 * The refresh token currently in GOOGLE_REFRESH_TOKEN (if you generated it
 * before this file existed) was issued with ONLY the Sheets + Drive scopes.
 * Sending mail needs `https://www.googleapis.com/auth/gmail.send` added to
 * that grant, and OAuth scopes are baked into the token at consent time —
 * you cannot "add" a scope to an existing refresh token after the fact.
 * scripts/get-refresh-token.js now requests gmail.send alongside the
 * existing scopes; you MUST re-run it and replace GOOGLE_REFRESH_TOKEN in
 * Vercel with the new value, or every call in this file fails with an
 * `insufficient authentication scopes` error. See SETUP.md.
 *
 * SINGLE-RECIPIENT RULE — enforced here, not just by caller discipline:
 * every send in this file goes to `applicationData.StudentEmail` and
 * nothing else. The Applications schema also has a ParentResidenceEmail
 * column (see _lib/schema.js APPLICATIONS_COLUMNS) — it's never read in
 * this file. Don't add a "cc the parents" convenience later without a
 * deliberate decision; it wasn't asked for. (The old ParentOfficeEmail /
 * GuardianResidenceEmail / GuardianOfficeEmail columns this comment used to
 * also list were removed from the schema entirely 2026-08-24 — there's no
 * guardian email column left in the schema at all, see APPLICATIONS_COLUMNS'
 * comment.)
 *
 * FAILURE HANDLING: every exported send function catches its own errors,
 * logs them to the Logs sheet via logEvent() (same pattern as the rest of
 * this codebase), and resolves to `false` — it never throws. Callers
 * (submitApplication.js, runAllocation.js) can therefore `await` these
 * directly without their own try/catch: a failed email can never fail or
 * roll back the application/allocation write that triggered it, because by
 * the time these run, that write has already succeeded.
 * ============================================================================
 */

const { google } = require('googleapis');
const { getAuth, logEvent } = require('./sheets');

let cachedGmailClient = null;

function getGmailClient() {
  if (!cachedGmailClient) {
    cachedGmailClient = google.gmail({ version: 'v1', auth: getAuth() });
  }
  return cachedGmailClient;
}

/** Base64url per RFC 4648 §5 — what the Gmail API's `raw` field requires (plain base64 with +/ is rejected). */
function toBase64Url(input) {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Hand-builds an RFC 2822 multipart/mixed MIME message (HTML body +
 * one PDF attachment) — the Gmail API takes a fully-formed raw message,
 * not a body/attachment pair, so there's no lighter-weight option here
 * without pulling in an email-composing dependency this project doesn't
 * otherwise need. `From` is deliberately omitted: Gmail fills it in as
 * whichever account owns the refresh token, which is always correct here
 * and avoids a mismatch error if that account has multiple send-as aliases.
 */
function buildMimeMessage({ to, subject, htmlBody, attachment }) {
  const boundary = `hostel_portal_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  return [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlBody,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    attachment.buffer.toString('base64'),
    '',
    `--${boundary}--`
  ].join('\r\n');
}

/** Shared send path for both notification types below — builds the MIME message and calls gmail.users.messages.send, swallowing and logging any failure. */
async function sendEmailWithAttachment({ to, subject, htmlBody, attachment, context, enrolmentNo }) {
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    await logEvent(context, `Skipped — no valid StudentEmail on file ("${to || ''}").`, enrolmentNo);
    return false;
  }

  try {
    const gmail = getGmailClient();
    const raw = toBase64Url(buildMimeMessage({ to, subject, htmlBody, attachment }));
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return true;
  } catch (err) {
    await logEvent(context, `Email send failed: ${err.message}`, enrolmentNo);
    return false;
  }
}

/** Sends the application-received confirmation, with the receipt PDF attached, to `applicationData.StudentEmail` only. */
async function sendApplicationConfirmationEmail(applicationData, pdfBuffer) {
  const applicationId = applicationData.ApplicationID || '';
  const name = applicationData.Name || 'Student';

  const htmlBody = `
    <p>Dear ${escapeHtml(name)},</p>
    <p>Your hostel application has been received and recorded. Your Application ID is
      <strong>${escapeHtml(applicationId)}</strong> — keep it for reference.</p>
    <p>A copy of your submitted application is attached as a PDF.</p>
    <p>This is a confirmation of receipt only; it does not confirm hostel allotment. You will receive a
      separate email if and when a seat is allotted to you.</p>
    <p>— GGSIPU Hostel Allocation Portal</p>
  `.trim();

  return sendEmailWithAttachment({
    to: applicationData.StudentEmail,
    subject: `Application Received — ${applicationId}`,
    htmlBody,
    attachment: { filename: `Application-${applicationId || 'receipt'}.pdf`, buffer: pdfBuffer },
    context: 'sendApplicationConfirmationEmail',
    enrolmentNo: applicationData.EnrolmentNo
  });
}

/** Sends the allotment confirmation, with the formal allotment letter PDF attached, to `applicationData.StudentEmail` only. */
async function sendAllotmentEmail(applicationData, pdfBuffer) {
  const applicationId = applicationData.ApplicationID || '';
  const name = applicationData.Name || 'Student';

  const htmlBody = `
    <p>Dear ${escapeHtml(name)},</p>
    <p>A hostel seat has been allotted to you against Application ID
      <strong>${escapeHtml(applicationId)}</strong>. Your formal allotment letter, with room details, is attached
      as a PDF.</p>
    <p>Please report to the hostel office with the required documents to complete your check-in formalities.</p>
    <p>— GGSIPU Hostel Allocation Portal</p>
  `.trim();

  return sendEmailWithAttachment({
    to: applicationData.StudentEmail,
    subject: `Hostel Allotment Confirmed — ${applicationId}`,
    htmlBody,
    attachment: { filename: `Allotment-Letter-${applicationId || 'letter'}.pdf`, buffer: pdfBuffer },
    context: 'sendAllotmentEmail',
    enrolmentNo: applicationData.EnrolmentNo
  });
}

/**
 * Sends the room-reassignment notification, with a freshly generated
 * allotment-letter PDF reflecting the NEW room, to `applicationData.StudentEmail`
 * only. Distinct subject/body from sendAllotmentEmail() on purpose — this is
 * a follow-up move of an already-allotted student (api/admin/shiftStudent.js),
 * not a first-time "Allotment Confirmed" notice, and re-sending that subject
 * line here would misleadingly read as a brand-new allotment.
 */
async function sendRoomChangeEmail(applicationData, pdfBuffer, { oldRoomNo, newRoomNo } = {}) {
  const applicationId = applicationData.ApplicationID || '';
  const name = applicationData.Name || 'Student';

  const htmlBody = `
    <p>Dear ${escapeHtml(name)},</p>
    <p>Your hostel room assignment against Application ID <strong>${escapeHtml(applicationId)}</strong> has been
      updated by the Hostel Office. You have been moved from room <strong>${escapeHtml(oldRoomNo || '—')}</strong>
      to room <strong>${escapeHtml(newRoomNo || '—')}</strong>. Your updated allotment letter is attached as a PDF.</p>
    <p>Please contact the Hostel Office if you have any questions about this change.</p>
    <p>— GGSIPU Hostel Allocation Portal</p>
  `.trim();

  return sendEmailWithAttachment({
    to: applicationData.StudentEmail,
    subject: `Room Reassignment — ${applicationId}`,
    htmlBody,
    attachment: { filename: `Room-Reassignment-${applicationId || 'letter'}.pdf`, buffer: pdfBuffer },
    context: 'sendRoomChangeEmail',
    enrolmentNo: applicationData.EnrolmentNo
  });
}

/** Minimal HTML-escaping for the two free-text values (Name, ApplicationID) interpolated into the bodies above. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  sendApplicationConfirmationEmail,
  sendAllotmentEmail,
  sendRoomChangeEmail
};
