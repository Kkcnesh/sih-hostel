/**
 * ============================================================================
 * PDF GENERATION — application receipt + allotment letter
 * ============================================================================
 * Built with `pdfkit` (pure-JS, no headless browser) — deliberate choice to
 * keep serverless cold-starts fast and stay inside the "low-cost lite"
 * architecture (see SETUP.md / project memory). Both exported functions
 * return a plain Buffer, never write to disk — required for a stateless
 * Vercel function, and lets the caller attach the Buffer straight into a
 * Gmail API message (see _lib/mailer.js).
 *
 * Only pdfkit's built-in Helvetica family is used (bundled AFM metrics, no
 * external font files) — a serverless filesystem is read-only/ephemeral, so
 * loading a custom .ttf at runtime is something to actively avoid here.
 *
 * Both documents reuse the portal's own navy/gold/orange palette (see
 * css/stylesheet.css :root — --navy #0B0B4E, --gold #E8B923,
 * --orange #F5A93C) and the exact university name/sub-title used in the
 * site header (js/script.js renderSiteHeader()), so the PDFs read as the
 * same institution as the web pages, not a separately-designed document.
 * ============================================================================
 */

const PDFDocument = require('pdfkit');

const NAVY = '#0B0B4E';
const GOLD = '#E8B923';
const ORANGE = '#F5A93C';
const INK = '#1A1A1A';
const MUTED = '#555555';

const UNIVERSITY_NAME = 'Guru Gobind Singh Indraprastha University';
const PORTAL_NAME = 'Hostel Allocation Portal';

// ----------------------------------------------------------------------------
// Small drawing helpers shared by both documents — kept local to this file
// since nothing outside pdf.js needs them.
// ----------------------------------------------------------------------------

/** Runs `doc` through the standard pdfkit "collect chunks into a Buffer" dance. Callers pass a function that does all the drawing; this handles create/collect/resolve. */
function renderToBuffer(drawFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      drawFn(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** Navy banner across the top of the page — university name in white, portal name in gold, matching the site header's crest row. */
function drawLetterhead(doc, { documentTitle }) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const top = doc.page.margins.top - 30;

  doc.rect(left, top, width, 70).fill(NAVY);

  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15)
    .text(UNIVERSITY_NAME, left + 14, top + 12, { width: width - 28 });

  doc.fillColor(GOLD).font('Helvetica').fontSize(10.5)
    .text(PORTAL_NAME, left + 14, top + 33, { width: width - 28 });

  doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(10.5)
    .text(documentTitle.toUpperCase(), left + 14, top + 50, { width: width - 28 });

  doc.fillColor(INK).font('Helvetica').fontSize(10);
  doc.y = top + 84;
}

/** Section banner — navy bar, white caps text — matches drawLetterhead's palette so a document reads as one system. */
function drawSectionHeader(doc, title) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  ensureSpace(doc, 40);
  const startY = doc.y + 10;

  doc.rect(left, startY, width, 20).fill(NAVY);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10.5)
    .text(title.toUpperCase(), left + 8, startY + 5.5, { width: width - 16 });

  doc.fillColor(INK).font('Helvetica').fontSize(10);
  doc.y = startY + 28;
}

/** One label/value row, label in a fixed-width bold column so a page of these lines up like a form, not a paragraph. */
function drawField(doc, label, value) {
  const left = doc.page.margins.left;
  const labelWidth = 175;
  const valueWidth = contentWidth(doc) - labelWidth;
  ensureSpace(doc, 16);
  const y = doc.y;

  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED)
    .text(label, left, y, { width: labelWidth });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK)
    .text(value && String(value).trim() ? String(value) : '—', left + labelWidth, y, { width: valueWidth });

  doc.y = Math.max(doc.y, y + 14) + 4;
}

/** Forces a fresh page if fewer than `minHeight` points remain, so a section header never lands as the last line on a page. */
function ensureSpace(doc, minHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + minHeight > bottom) doc.addPage();
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString || '—');
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Joins the structured residence-address columns into one readable line; drops any blank part instead of leaving stray commas. */
function joinAddressParts(parts) {
  return parts.map((p) => String(p || '').trim()).filter(Boolean).join(', ');
}

// ----------------------------------------------------------------------------
// generateApplicationPDF — confirmation/receipt, not an official letter
// ----------------------------------------------------------------------------

/**
 * A clean receipt-style PDF of everything the student submitted —
 * `applicationData` is the same {ColumnName: value} row object
 * buildApplicationRow() produces / writeRowAt() writes to the Applications
 * sheet (i.e. call this with the exact `rowObject` submitApplication.js
 * already builds, no reshaping needed).
 */
function generateApplicationPDF(applicationData) {
  return renderToBuffer((doc) => {
    drawLetterhead(doc, { documentTitle: 'Application Receipt' });

    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
      .text(`Application ID: ${applicationData.ApplicationID || '—'}`, doc.page.margins.left, doc.y);
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
      .text(`Submitted: ${formatTimestamp(applicationData.SubmissionTimestamp)}`, doc.page.margins.left, doc.y + 2);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
      .text('This is a confirmation of receipt only — it does not confirm hostel allotment.', doc.page.margins.left, doc.y, { width: contentWidth(doc) });
    doc.fillColor(INK);

    drawSectionHeader(doc, 'Personal & Academic Details');
    drawField(doc, 'Name', applicationData.Name);
    drawField(doc, 'Enrolment No.', applicationData.EnrolmentNo);
    drawField(doc, 'Nationality', applicationData.Nationality);
    drawField(doc, 'Date of Birth', applicationData.DOB);
    drawField(doc, 'Course', applicationData.Course);
    drawField(doc, 'School', applicationData.School);
    drawField(doc, 'Date of Joining University', applicationData.DateOfJoiningUniversity);
    drawField(doc, 'Category (Residence)', applicationData.CategoryResidence);
    drawField(doc, 'Category (Reservation)', applicationData.CategoryReservation);
    drawField(doc, 'Student Mobile', applicationData.StudentMobile);
    drawField(doc, 'Student Email', applicationData.StudentEmail);
    if (applicationData.ExtraCurricular) drawField(doc, 'Extra-Curricular', applicationData.ExtraCurricular);

    drawSectionHeader(doc, 'Family Details');
    drawField(doc, "Father's Name", applicationData.FatherName);
    drawField(doc, "Father's Phone", applicationData.FatherPhone);
    drawField(doc, "Mother's Name", applicationData.MotherName);
    drawField(doc, "Mother's Phone", applicationData.MotherPhone);
    drawField(doc, 'Residence Address', joinAddressParts([
      applicationData.ParentResidenceHouseNo,
      applicationData.ParentResidenceStreetArea,
      applicationData.ParentResidenceLandmark,
      applicationData.ParentResidenceCity,
      applicationData.ParentResidenceDistrict,
      applicationData.ParentResidenceState,
      applicationData.ParentResidencePincode
    ]));
    if (applicationData.ParentResidenceTel) drawField(doc, 'Residence Telephone', applicationData.ParentResidenceTel);
    if (applicationData.ParentResidenceEmail) drawField(doc, 'Residence Email', applicationData.ParentResidenceEmail);
    drawField(doc, 'Emergency Contact Address', applicationData.EmergencyAddress);
    drawField(doc, 'Emergency Contact Telephone', applicationData.EmergencyTel);

    // Local guardian is an entirely optional section in the current UI
    // (see schema.js validateApplicationFields()) — only print it if the
    // student actually filled it in, rather than a page of em-dashes.
    if (applicationData.GuardianName) {
      drawSectionHeader(doc, 'Local Guardian');
      drawField(doc, 'Name', applicationData.GuardianName);
      drawField(doc, 'Relationship', applicationData.GuardianRelationship);
      drawField(doc, 'Phone', applicationData.GuardianPhone);
      drawField(doc, 'Address', joinAddressParts([
        applicationData.GuardianHouseNo,
        applicationData.GuardianStreetArea,
        applicationData.GuardianLandmark,
        applicationData.GuardianCity,
        applicationData.GuardianDistrict,
        applicationData.GuardianState,
        applicationData.GuardianPincode
      ]));
    }

    drawSectionHeader(doc, 'Hostel Preference');
    drawField(doc, 'Hostel', applicationData.HostelChoice);
    drawField(doc, 'Room Type Preference', applicationData.RoomTypePreference);
    if (applicationData.RoommatePreferenceEnrolmentNo) {
      drawField(doc, 'Requested Roommate (Enrolment No.)', applicationData.RoommatePreferenceEnrolmentNo);
    }

    doc.moveDown(1);
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED)
      .text('Auto-generated by the GGSIPU Hostel Allocation Portal. Keep this receipt for your records.', doc.page.margins.left, doc.y, { width: contentWidth(doc) });
  });
}

// ----------------------------------------------------------------------------
// generateAllotmentPDF — formal allotment letter
// ----------------------------------------------------------------------------

/**
 * Formal hostel allotment letter. `applicationData` is the same row-object
 * shape as generateApplicationPDF (post-allocation state is fine — only
 * Name/ApplicationID/SubmissionTimestamp are read from it). `allotmentDetails`
 * is `{ hostel, roomType, roomNo, roommateName }` — `roommateName` may be
 * null/empty for a student allotted a room alone.
 */
function generateAllotmentPDF(applicationData, allotmentDetails) {
  const { hostel, roomType, roomNo, roommateName } = allotmentDetails || {};

  return renderToBuffer((doc) => {
    drawLetterhead(doc, { documentTitle: 'Hostel Allotment Letter' });

    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED)
      .text(`Ref: ${applicationData.ApplicationID || '—'}`, doc.page.margins.left, doc.y);
    doc.text(`Date: ${formatTimestamp(new Date().toISOString())}`, doc.page.margins.left, doc.y + 2);
    doc.moveDown(1.2);

    doc.fillColor(INK).font('Helvetica').fontSize(10.5)
      .text(`Dear ${applicationData.Name || 'Student'},`, doc.page.margins.left, doc.y, { width: contentWidth(doc) });
    doc.moveDown(0.6);

    doc.text(
      `We are pleased to inform you that, on the basis of your hostel application ` +
      `(Application ID: ${applicationData.ApplicationID || '—'}), a seat has been allotted to you as detailed below.`,
      doc.page.margins.left, doc.y, { width: contentWidth(doc) }
    );

    drawSectionHeader(doc, 'Allotment Details');
    drawField(doc, 'Student Name', applicationData.Name);
    drawField(doc, 'Enrolment No.', applicationData.EnrolmentNo);
    drawField(doc, 'Application ID', applicationData.ApplicationID);
    drawField(doc, 'Hostel', hostel);
    drawField(doc, 'Room Type', roomType);
    drawField(doc, 'Room No.', roomNo);
    drawField(doc, 'Roommate', roommateName || 'Not paired — allotted individually');

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(
      'Please report to the hostel office with the required documents (original identity proof, a copy of this ' +
      'allotment letter, and any documents specified in the hostel admission brochure) to complete your check-in ' +
      'formalities. For any queries regarding this allotment, please contact the Hostel Office.',
      doc.page.margins.left, doc.y, { width: contentWidth(doc) }
    );

    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(10).text('Hostel Administration', doc.page.margins.left, doc.y);
    doc.font('Helvetica').fontSize(10).text(UNIVERSITY_NAME, doc.page.margins.left, doc.y + 2);

    doc.moveDown(1.5);
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED)
      .text('This letter was generated automatically by the GGSIPU Hostel Allocation Portal.', doc.page.margins.left, doc.y, { width: contentWidth(doc) });
  });
}

module.exports = {
  generateApplicationPDF,
  generateAllotmentPDF
};
