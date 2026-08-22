/**
 * ============================================================================
 * SHEET SCHEMA + PURE HELPERS
 * ============================================================================
 * Ported verbatim from Code.gs (the retired Apps Script backend) — column
 * names, order, and validation rules are the source of truth other parts of
 * the app depend on. Don't rename/reorder anything here without updating the
 * HostelDB sheet's actual header row to match.
 * ============================================================================
 */

const SHEET_NAMES = {
  ELIGIBILITY: 'Eligibility',
  APPLICATIONS: 'Applications',
  ROOM_INVENTORY: 'RoomInventory',
  COUNTERS: 'Counters',
  LOGS: 'Logs'
};

const ELIGIBILITY_COLUMNS = ['EnrolmentNo', 'Name', 'DOB', 'Course', 'School', 'Gender'];

const APPLICATIONS_COLUMNS = [
  'ApplicationID', 'EnrolmentNo', 'Name', 'Nationality', 'DOB', 'Course', 'School',
  'DateOfJoiningUniversity', 'CategoryResidence', 'CategoryReservation',
  'FatherName', 'MotherName',
  'ParentOfficeAddress', 'ParentOfficeTel', 'ParentOfficeEmail',
  'ParentResidenceAddress', 'ParentResidenceTel', 'ParentResidenceEmail',
  'GuardianOfficeAddress', 'GuardianOfficeTel', 'GuardianOfficeEmail',
  'GuardianResidenceAddress', 'GuardianResidenceTel', 'GuardianResidenceEmail',
  'EmergencyAddress', 'EmergencyTel',
  'StudentMobile', 'StudentEmail', 'ExtraCurricular',
  'HostelChoice', 'RoomTypePreference', 'RoommatePreferenceEnrolmentNo',
  'PhotoDriveLink', 'AadharDriveLink', 'MarksheetsDriveLink',
  'MedicalCertDriveLink', 'GuardianConsentDriveLink', 'AntiRaggingDriveLink',
  'SubmissionTimestamp', 'VerificationStatus', 'AllotmentStatus',
  'AllottedRoomNo', 'AllottedRoommateEnrolmentNo', 'WaitlistPosition'
];

// The only two values VerificationStatus is ever set to — confirmed against
// buildApplicationRow() below (default 'Pending') and submitApplication.js's
// existing.VerificationStatus !== 'Pending' lock check, not guessed. Used by
// api/admin/updateVerification.js to reject anything else with a 400 rather
// than writing an arbitrary string into the sheet.
const VERIFICATION_STATUSES = ['Pending', 'Verified'];

const ROOM_INVENTORY_COLUMNS = ['RoomNo', 'Hostel', 'RoomType', 'Capacity', 'Occupied'];
const COUNTERS_COLUMNS = ['CounterName', 'NextValue'];
const LOGS_COLUMNS = ['Timestamp', 'EnrolmentNo', 'Context', 'Message'];

// Client-side document keys (js/script.js DOCUMENT_CONFIG) -> the
// Applications column each one's Drive link is written to. Also doubles as
// the whitelist uploadDocument validates docType against.
const DOC_TYPE_COLUMNS = {
  Photo: 'PhotoDriveLink',
  Aadhar: 'AadharDriveLink',
  Marksheets: 'MarksheetsDriveLink',
  MedicalCert: 'MedicalCertDriveLink',
  GuardianConsent: 'GuardianConsentDriveLink',
  AntiRagging: 'AntiRaggingDriveLink'
};

// Reverse of the client's DOCUMENT_CONFIG[i].serverDocType map (js/script.js) —
// used by getApplicationStatus to hand the documents checklist back in the
// key shape the client's renderDocChecklist() already expects.
const SERVER_TO_CLIENT_DOC_KEY = {
  Photo: 'photo',
  Aadhar: 'aadhar',
  Marksheets: 'marksheets',
  MedicalCert: 'medical',
  GuardianConsent: 'guardianConsent',
  AntiRagging: 'antiRagging'
};

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB — mirrors the client-side limit; don't only trust the client
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
const DRIVE_ROOT_FOLDER_NAME = 'Hostel Applications';

/** 0-indexed column position of `name` within a columns array — throws on a typo instead of silently reading the wrong cell. */
function columnIndex(columns, name) {
  const idx = columns.indexOf(name);
  if (idx === -1) throw new Error(`Unknown column "${name}"`);
  return idx;
}

/** Turns a sheet row (array of cell values) into a {ColumnName: value} object. */
function rowToObject(columns, rowValues) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = rowValues[i] !== undefined ? rowValues[i] : ''; });
  return obj;
}

/**
 * Parses a DOB value from the Eligibility sheet into a normalized
 * YYYY-MM-DD string, or null if it doesn't match a recognized format.
 *
 * Why this exists: the Sheets API always returns cell values as plain
 * strings (never real Date objects), and the Eligibility sheet's DOB
 * column is a plain-text cell — existing data was hand-typed as
 * DD/MM/YYYY (e.g. "01/01/2007", sometimes without leading zeros —
 * "1/1/2007"). The client's <input type="date"> always sends YYYY-MM-DD,
 * so comparing the two as raw strings ("2007-01-01" vs "01/01/2007")
 * silently fails for every real match. This is deliberately
 * format-tolerant instead of a plain string compare — do not "simplify"
 * it back to one without re-solving that mismatch.
 *
 * Returning null (rather than falling back to the raw string) is
 * deliberate too: an unparseable value should never accidentally compare
 * equal to another unparseable value — see the null-guard at the login.js
 * call site.
 */
function parseSheetDate(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  // Already YYYY-MM-DD (in case data ever gets re-seeded in this format).
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return toIsoDate(year, month, day);
  }

  // DD/MM/YYYY — the existing hand-typed format. 1 or 2 digits for day/month;
  // leading zeros are not required ("1/1/2007" parses the same as "01/01/2007").
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return toIsoDate(year, month, day);
  }

  return null;
}

/** Zero-pads year/month/day into "YYYY-MM-DD", rejecting out-of-range or non-existent dates (e.g. day 31 in February) rather than letting Date silently roll them over into the next month. */
function toIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }

  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isValidEmailServer(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

/** Reads a dotted path ('localGuardian.office.tel') off a plain object; undefined if any segment is missing. */
function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

/** Mirrors the client-side required/optional split (see application.html) — a server-side backstop, not the primary UX. */
function validateApplicationFields(formData) {
  const errors = {};

  const requireText = (path, label) => {
    const value = getPath(formData, path);
    if (!value || !String(value).trim()) errors[path] = `${label} is required.`;
  };
  const requireEmail = (path, label) => {
    requireText(path, label);
    const value = getPath(formData, path);
    if (value && !isValidEmailServer(value)) errors[path] = `${label} must be a valid email address.`;
  };

  requireText('nationality', 'Nationality');
  requireText('dateOfJoining', 'Date of joining university');
  requireText('category', 'Category');
  requireText('reservationCategory', 'Reservation category');
  requireText('fatherName', "Father's name");
  requireText('motherName', "Mother's name");
  requireText('residenceAddress.address', 'Residence address');
  requireText('residenceAddress.tel', 'Residence telephone number');
  requireEmail('residenceAddress.email', 'Residence email');
  requireText('studentMobile', 'Mobile number');
  requireEmail('studentEmail', 'Student email');
  requireText('emergencyAddress', 'Emergency contact address');
  requireText('emergencyTel', 'Emergency contact telephone number');
  requireText('localGuardian.residence.address', "Guardian's residence address");
  requireText('localGuardian.residence.tel', "Guardian's residence telephone number");
  requireEmail('localGuardian.residence.email', "Guardian's residence email");
  requireText('localGuardian.office.address', "Guardian's office address");
  requireText('localGuardian.office.tel', "Guardian's office telephone number");
  requireEmail('localGuardian.office.email', "Guardian's office email");
  requireText('hostel', 'Hostel');
  requireText('roomType', 'Room type preference');

  ['photo', 'aadhar', 'marksheets', 'medical', 'guardianConsent', 'antiRagging'].forEach((key) => {
    if (!getPath(formData, `documents.${key}.driveLink`)) {
      errors[`documents.${key}`] = `The ${key} document is required.`;
    }
  });

  if (formData.studentMobile && !/^[6-9]\d{9}$/.test(String(formData.studentMobile).trim())) {
    errors.studentMobile = 'Mobile number must be a valid 10-digit number.';
  }

  return errors;
}

function buildApplicationRow(formData, elig, applicationId) {
  const docs = formData.documents || {};
  const driveLink = (key) => (docs[key] && docs[key].driveLink) || '';

  return {
    ApplicationID: applicationId,
    EnrolmentNo: elig.EnrolmentNo,
    Name: elig.Name,
    Nationality: formData.nationality,
    // parseSheetDate() falling back to the raw trimmed value is a defensive
    // edge case, not the expected path — a row only gets this far because
    // login already matched this same Eligibility DOB against the one the
    // student typed, so it should already be parseable. Preferring to store
    // *something* over silently writing an empty DOB is the safer failure.
    DOB: parseSheetDate(elig.DOB) || String(elig.DOB || '').trim(),
    Course: elig.Course,
    School: elig.School,
    DateOfJoiningUniversity: formData.dateOfJoining,
    CategoryResidence: formData.category,
    CategoryReservation: formData.reservationCategory,
    FatherName: formData.fatherName,
    MotherName: formData.motherName,
    ParentOfficeAddress: getPath(formData, 'officeAddress.address') || '',
    ParentOfficeTel: getPath(formData, 'officeAddress.tel') || '',
    ParentOfficeEmail: getPath(formData, 'officeAddress.email') || '',
    ParentResidenceAddress: getPath(formData, 'residenceAddress.address') || '',
    ParentResidenceTel: getPath(formData, 'residenceAddress.tel') || '',
    ParentResidenceEmail: getPath(formData, 'residenceAddress.email') || '',
    GuardianOfficeAddress: getPath(formData, 'localGuardian.office.address') || '',
    GuardianOfficeTel: getPath(formData, 'localGuardian.office.tel') || '',
    GuardianOfficeEmail: getPath(formData, 'localGuardian.office.email') || '',
    GuardianResidenceAddress: getPath(formData, 'localGuardian.residence.address') || '',
    GuardianResidenceTel: getPath(formData, 'localGuardian.residence.tel') || '',
    GuardianResidenceEmail: getPath(formData, 'localGuardian.residence.email') || '',
    EmergencyAddress: formData.emergencyAddress,
    EmergencyTel: formData.emergencyTel,
    StudentMobile: formData.studentMobile,
    StudentEmail: formData.studentEmail,
    ExtraCurricular: formData.extraCurricular || '',
    HostelChoice: formData.hostel,
    RoomTypePreference: formData.roomType,
    RoommatePreferenceEnrolmentNo: formData.roommateEnrolment || '',
    PhotoDriveLink: driveLink('photo'),
    AadharDriveLink: driveLink('aadhar'),
    MarksheetsDriveLink: driveLink('marksheets'),
    MedicalCertDriveLink: driveLink('medical'),
    GuardianConsentDriveLink: driveLink('guardianConsent'),
    AntiRaggingDriveLink: driveLink('antiRagging'),
    SubmissionTimestamp: new Date().toISOString(),
    VerificationStatus: 'Pending',
    AllotmentStatus: 'Not Processed',
    AllottedRoomNo: '',
    AllottedRoommateEnrolmentNo: '',
    WaitlistPosition: ''
  };
}

/** One Applications cell can hold a single Drive link or a comma-joined list (Marksheets) — split it back into a plain array of links. */
function splitDriveLinks(rawLink) {
  if (!rawLink) return [];
  return String(rawLink).split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  SHEET_NAMES,
  ELIGIBILITY_COLUMNS,
  APPLICATIONS_COLUMNS,
  VERIFICATION_STATUSES,
  ROOM_INVENTORY_COLUMNS,
  COUNTERS_COLUMNS,
  LOGS_COLUMNS,
  DOC_TYPE_COLUMNS,
  SERVER_TO_CLIENT_DOC_KEY,
  MAX_UPLOAD_BYTES,
  ALLOWED_MIME_TYPES,
  DRIVE_ROOT_FOLDER_NAME,
  columnIndex,
  rowToObject,
  parseSheetDate,
  isValidEmailServer,
  getPath,
  validateApplicationFields,
  buildApplicationRow,
  splitDriveLinks
};
