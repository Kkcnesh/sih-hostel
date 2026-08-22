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
 * Sheets may hand back a date as a "YYYY-MM-DD"-ish string or (depending on
 * cell formatting) something else entirely — normalize to plain YYYY-MM-DD
 * so DOB comparisons are reliable. The Sheets API (unlike Apps Script's
 * SpreadsheetApp) always returns values.get() results as strings/numbers,
 * never real Date objects, so this is simpler than the original but keeps
 * the same normalized output shape.
 */
function normalizeDate(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value || '').trim();
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
    DOB: normalizeDate(elig.DOB),
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
  normalizeDate,
  isValidEmailServer,
  getPath,
  validateApplicationFields,
  buildApplicationRow,
  splitDriveLinks
};
