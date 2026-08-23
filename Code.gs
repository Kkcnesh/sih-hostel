/**
 * ============================================================================
 * GGSIPU HOSTEL PORTAL — SERVER (Code.gs)
 * ============================================================================
 * Sheets + Drive backend for the student portal. No external DB, no server,
 * no paid services, per the "low-cost lite" brief.
 *
 * SETUP (do this once):
 *   1. Create a Google Sheet named "HostelDB" (or bind this script to an
 *      existing one via Extensions > Apps Script).
 *   2. If this script is standalone (not bound to that Sheet), paste the
 *      Sheet's ID into SHEET_ID below — copy it from the Sheet's URL:
 *      https://docs.google.com/spreadsheets/d/COPY_THIS_PART/edit
 *      If it IS bound to the Sheet, leave SHEET_ID as-is; getDB() falls
 *      back to the bound spreadsheet automatically.
 *   3. Run setupSheets() once (pick it from the function dropdown above
 *      the editor and click Run). It creates every tab below with headers.
 *   4. Deploy > New deployment > Web app, "Execute as: Me",
 *      "Who has access: Anyone" (this app does its own enrolment+DOB check,
 *      it doesn't rely on Google account login — see loginStudent()).
 *
 * TABLE OF CONTENTS
 * -----------------
 * 1. Configuration & sheet schema
 * 2. doGet router + template include helper
 * 3. Sheet bootstrap (setupSheets)
 * 4. Sheet / column / logging helpers
 * 5. loginStudent
 * 6. uploadDocument
 * 7. submitApplication
 * 8. getApplicationStatus
 * 9. Field validation + Drive/date helpers used by the four functions above
 * ============================================================================
 */

/* ============================================================================
   1. CONFIGURATION & SHEET SCHEMA
   ============================================================================
   Column order here IS the column order in the Sheet — setupSheets() writes
   these arrays as the header row. Change a column, and every function that
   reads/writes it (via columnIndex()) automatically follows; don't hardcode
   column letters/numbers anywhere outside this block.
   ============================================================================ */
const SHEET_ID = 'PASTE_YOUR_HOSTELDB_SHEET_ID_HERE';

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

// Client-side document keys (JavaScript.html DOCUMENT_CONFIG) -> the
// Applications column each one's Drive link is written to. Also doubles as
// the whitelist uploadDocument() validates docType against.
const DOC_TYPE_COLUMNS = {
  Photo: 'PhotoDriveLink',
  Aadhar: 'AadharDriveLink',
  Marksheets: 'MarksheetsDriveLink',
  MedicalCert: 'MedicalCertDriveLink',
  GuardianConsent: 'GuardianConsentDriveLink',
  AntiRagging: 'AntiRaggingDriveLink'
};

// Reverse of the client's DOCUMENT_CONFIG[i].serverDocType map (JavaScript.html) —
// used by getApplicationStatus() to hand the documents checklist back in the
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


/* ============================================================================
   2. doGet ROUTER + TEMPLATE INCLUDE HELPER
   ============================================================================
   Only 3 real page loads: Login, Application (the whole 6-step wizard as
   one page — see Application.html), and Status. The 6 steps are NOT
   separate ?page= routes — Apps Script serves every page inside a
   sandboxed iframe, and Chrome refuses any script-triggered top-level
   navigation out of it without genuine user activation (a real click),
   which a `?page=family`-style JS redirect between steps never carries.
   Application.html instead switches steps by showing/hiding sections with
   plain DOM manipulation, no navigation at all. See pageUrl() in
   JavaScript.html for the (now much shorter) link-building helper, and its
   renderGatePanel() for how "you need to be somewhere else" states are
   shown as a real link to click rather than a forced redirect.
   ============================================================================ */
const PAGE_TEMPLATES = {
  login: 'Login',
  application: 'Application',
  status: 'Status'
};

function doGet(e) {
  const page = ((e && e.parameter && e.parameter.page) || 'login').toLowerCase();
  const templateName = PAGE_TEMPLATES[page] || PAGE_TEMPLATES.login;

  const template = HtmlService.createTemplateFromFile(templateName);
  template.baseUrl = ScriptApp.getService().getUrl();

  return template.evaluate()
    .setTitle('GGSIPU Hostel Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Used inside templates as <?!= include('Stylesheet') ?> / <?!= include('JavaScript') ?>. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/* ============================================================================
   3. SHEET BOOTSTRAP
   ============================================================================
   Run setupSheets() once, by hand, against the HostelDB spreadsheet. Safe
   to re-run — it only creates tabs/headers that don't already exist, it
   never overwrites data.
   ============================================================================ */
function setupSheets() {
  const db = getDB();

  ensureSheetWithHeaders(db, SHEET_NAMES.ELIGIBILITY, ELIGIBILITY_COLUMNS);
  ensureSheetWithHeaders(db, SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS);
  ensureSheetWithHeaders(db, SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS);
  const countersSheet = ensureSheetWithHeaders(db, SHEET_NAMES.COUNTERS, COUNTERS_COLUMNS);
  ensureSheetWithHeaders(db, SHEET_NAMES.LOGS, LOGS_COLUMNS);

  // Seed the ApplicationID counter row if it isn't there yet.
  if (findRowByValue(countersSheet, 1, 'ApplicationID') === -1) {
    countersSheet.appendRow(['ApplicationID', 0]);
  }

  // Apps Script gives every new spreadsheet a blank "Sheet1" — drop it if
  // it's still empty, so the tab list only shows sheets this project uses.
  const defaultSheet = db.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0) {
    db.deleteSheet(defaultSheet);
  }

  Logger.log('setupSheets() complete: ' + Object.values(SHEET_NAMES).join(', '));
}

function ensureSheetWithHeaders(db, sheetName, columns) {
  let sheet = db.getSheetByName(sheetName);
  if (!sheet) {
    sheet = db.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}


/* ============================================================================
   4. SHEET / COLUMN / LOGGING HELPERS
   ============================================================================ */
function getDB() {
  return SHEET_ID.startsWith('PASTE_')
    ? SpreadsheetApp.getActiveSpreadsheet()
    : SpreadsheetApp.openById(SHEET_ID);
}

function getSheet(name) {
  return getDB().getSheetByName(name);
}

/** 1-indexed column position of `name` within a columns array — throws on a typo instead of silently reading the wrong cell. */
function columnIndex(columns, name) {
  const idx = columns.indexOf(name);
  if (idx === -1) throw new Error(`Unknown column "${name}"`);
  return idx + 1;
}

/** 1-indexed row number of the first row whose given column matches value, or -1 if none. */
function findRowByValue(sheet, columnIndex, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return -1;
  const values = sheet.getRange(1, columnIndex, lastRow, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(value).trim()) return i + 1;
  }
  return -1;
}

/** Turns a sheet row (array of cell values) into a {ColumnName: value} object. */
function rowToObject(columns, rowValues) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = rowValues[i]; });
  return obj;
}

/** Sheets may store a date as a real Date object or as a typed string — normalize both to YYYY-MM-DD so DOB comparisons are reliable. */
function normalizeDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value).trim();
}

/**
 * Zero-padded, year-scoped application reference — e.g. HA-2026-000123.
 * Not self-locking — the only caller (submitApplication) already holds the
 * script lock for its whole check-existing-row/write critical section, and
 * LockService locks aren't documented as safe to re-acquire (nest) within
 * a single execution, so this assumes the caller's lock covers it too.
 */
function generateApplicationId() {
  const sheet = getSheet(SHEET_NAMES.COUNTERS);
  const row = findRowByValue(sheet, 1, 'ApplicationID');
  const nextValue = Number(sheet.getRange(row, 2).getValue()) + 1;
  sheet.getRange(row, 2).setValue(nextValue);
  const year = new Date().getFullYear();
  return `HA-${year}-${String(nextValue).padStart(6, '0')}`;
}

/** Lightweight failure log — enough context to debug later, not a full audit trail. */
function logEvent(context, message, enrolmentNo) {
  try {
    getSheet(SHEET_NAMES.LOGS).appendRow([new Date(), enrolmentNo || '', context, message]);
  } catch (err) {
    Logger.log(`logEvent failed: ${err.message}`);
  }
}


/* ============================================================================
   5. loginStudent
   ============================================================================
   Looks the student up in Eligibility and reports whether they already have
   an Applications row, so the client knows whether to route to step 1 or
   straight to Status. Every function below returns {success:false, ...} for
   *expected* failures (not found, bad input) rather than throwing — Apps
   Script's withFailureHandler only fires on thrown exceptions, so an
   expected "no match" has to travel through withSuccessHandler like any
   other result. Only genuinely unexpected errors get thrown/logged.
   ============================================================================ */
function loginStudent(enrolmentNo, dob) {
  try {
    enrolmentNo = String(enrolmentNo || '').trim();
    if (!enrolmentNo || !dob) {
      return { success: false, error: 'Enter both your enrolment number and date of birth.' };
    }

    const eligSheet = getSheet(SHEET_NAMES.ELIGIBILITY);
    const eligRow = findRowByValue(eligSheet, columnIndex(ELIGIBILITY_COLUMNS, 'EnrolmentNo'), enrolmentNo);
    const NOT_FOUND = { success: false, error: 'We couldn’t find a match for that enrolment number and date of birth. Double-check both and try again.' };
    if (eligRow === -1) return NOT_FOUND;

    const eligValues = eligSheet.getRange(eligRow, 1, 1, ELIGIBILITY_COLUMNS.length).getValues()[0];
    const elig = rowToObject(ELIGIBILITY_COLUMNS, eligValues);
    if (normalizeDate(elig.DOB) !== normalizeDate(dob)) return NOT_FOUND;

    const appsSheet = getSheet(SHEET_NAMES.APPLICATIONS);
    const appRow = findRowByValue(appsSheet, columnIndex(APPLICATIONS_COLUMNS, 'EnrolmentNo'), enrolmentNo);
    let applicationId = null;
    if (appRow !== -1) {
      const appValues = appsSheet.getRange(appRow, 1, 1, APPLICATIONS_COLUMNS.length).getValues()[0];
      applicationId = rowToObject(APPLICATIONS_COLUMNS, appValues).ApplicationID;
    }

    return {
      success: true,
      student: {
        EnrolmentNo: enrolmentNo,
        Name: elig.Name,
        DOB: normalizeDate(elig.DOB),
        Course: elig.Course,
        School: elig.School,
        Gender: elig.Gender
      },
      hasExistingApplication: appRow !== -1,
      applicationId
    };
  } catch (err) {
    logEvent('loginStudent', err.message, enrolmentNo);
    return { success: false, error: 'Something went wrong checking your details. Please try again.' };
  }
}


/* ============================================================================
   6. uploadDocument
   ============================================================================
   Decodes one base64-encoded file and drops it into
   "Hostel Applications/<EnrolmentNo>/" in Drive. Called once per file from
   the client — the Documents step loops this for multi-file uploads
   (Marksheets) and joins the returned links itself; this function only
   ever handles one file at a time, matching its signature.
   ============================================================================ */
function uploadDocument(enrolmentNo, docType, base64Data, fileName, mimeType) {
  try {
    enrolmentNo = String(enrolmentNo || '').trim();
    if (!enrolmentNo) return { success: false, error: 'Missing enrolment number.' };
    if (!DOC_TYPE_COLUMNS.hasOwnProperty(docType)) {
      return { success: false, error: `Unknown document type "${docType}".` };
    }
    if (ALLOWED_MIME_TYPES.indexOf(mimeType) === -1) {
      return { success: false, error: 'Only JPG, PNG or PDF files are accepted.' };
    }

    let bytes;
    try {
      bytes = Utilities.base64Decode(base64Data);
    } catch (decodeErr) {
      return { success: false, error: 'That file could not be read. Please try selecting it again.' };
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return { success: false, error: 'File is over 5 MB — choose a smaller file.' };
    }

    const blob = Utilities.newBlob(bytes, mimeType, fileName);
    const studentFolder = getOrCreateStudentFolder(enrolmentNo);
    const file = studentFolder.createFile(blob);
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); // never public — admin access comes via being the file owner/domain, not a public link

    return { success: true, fileUrl: file.getUrl(), fileId: file.getId() };
  } catch (err) {
    logEvent('uploadDocument', `${docType}: ${err.message}`, enrolmentNo);
    return { success: false, error: 'Something went wrong uploading that file. Please try again.' };
  }
}


/* ============================================================================
   7. submitApplication
   ============================================================================
   Writes one row to Applications per student. If a Pending row already
   exists for this EnrolmentNo it's updated in place (edit-before-verification
   is allowed) and keeps its original ApplicationID; once VerificationStatus
   moves past "Pending" the row is locked and resubmission is rejected.

   Identity fields (Name/DOB/Course/School) are re-read from Eligibility
   here rather than trusted from the client — they're meant to be locked,
   uneditable fields in the UI, and re-deriving them server-side is what
   actually enforces that.
   ============================================================================ */
function submitApplication(formData) {
  try {
    const enrolmentNo = String((formData && formData.enrolmentNo) || '').trim();
    if (!enrolmentNo) return { success: false, error: 'Missing enrolment number.' };

    const eligSheet = getSheet(SHEET_NAMES.ELIGIBILITY);
    const eligRow = findRowByValue(eligSheet, columnIndex(ELIGIBILITY_COLUMNS, 'EnrolmentNo'), enrolmentNo);
    if (eligRow === -1) {
      return { success: false, error: 'This enrolment number is not on the eligibility list. Contact the Hostel Office.' };
    }
    const elig = rowToObject(ELIGIBILITY_COLUMNS, eligSheet.getRange(eligRow, 1, 1, ELIGIBILITY_COLUMNS.length).getValues()[0]);

    const errors = validateApplicationFields(formData);
    if (Object.keys(errors).length > 0) {
      return { success: false, errors };
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const appsSheet = getSheet(SHEET_NAMES.APPLICATIONS);
      const existingRow = findRowByValue(appsSheet, columnIndex(APPLICATIONS_COLUMNS, 'EnrolmentNo'), enrolmentNo);

      let applicationId;
      let targetRow;
      if (existingRow !== -1) {
        const existing = rowToObject(APPLICATIONS_COLUMNS, appsSheet.getRange(existingRow, 1, 1, APPLICATIONS_COLUMNS.length).getValues()[0]);
        if (existing.VerificationStatus !== 'Pending') {
          return { success: false, error: 'Your application has already been verified and can no longer be edited here. Contact the Hostel Office for changes.' };
        }
        applicationId = existing.ApplicationID;
        targetRow = existingRow;
      } else {
        applicationId = generateApplicationId();
        targetRow = appsSheet.getLastRow() + 1;
      }

      const rowObject = buildApplicationRow(formData, elig, applicationId);
      const rowValues = APPLICATIONS_COLUMNS.map((col) => (rowObject[col] === undefined ? '' : rowObject[col]));
      appsSheet.getRange(targetRow, 1, 1, APPLICATIONS_COLUMNS.length).setValues([rowValues]);

      return { success: true, applicationId };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    logEvent('submitApplication', err.message, formData && formData.enrolmentNo);
    return { success: false, error: 'Something went wrong submitting your application. Please try again.' };
  }
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
    SubmissionTimestamp: new Date(),
    VerificationStatus: 'Pending',
    AllotmentStatus: 'Not Processed',
    AllottedRoomNo: '',
    AllottedRoommateEnrolmentNo: '',
    WaitlistPosition: ''
  };
}


/* ============================================================================
   8. getApplicationStatus
   ============================================================================
   VerificationStatus is "Pending" | "Verified" (set by the not-yet-built
   admin dashboard). AllotmentStatus is "Not Processed" | "Allotted" |
   "Waitlisted" (set by the not-yet-built allocation engine). The client
   derives its 3-stage corridor display from these two columns — see
   deriveCorridorStatus() in Status.html.
   ============================================================================ */
function getApplicationStatus(enrolmentNo) {
  try {
    enrolmentNo = String(enrolmentNo || '').trim();
    const sheet = getSheet(SHEET_NAMES.APPLICATIONS);
    const row = findRowByValue(sheet, columnIndex(APPLICATIONS_COLUMNS, 'EnrolmentNo'), enrolmentNo);
    if (row === -1) {
      return { success: false, error: 'No application found for this student yet.' };
    }
    const record = rowToObject(APPLICATIONS_COLUMNS, sheet.getRange(row, 1, 1, APPLICATIONS_COLUMNS.length).getValues()[0]);

    const documents = {};
    Object.keys(DOC_TYPE_COLUMNS).forEach((docType) => {
      const clientKey = SERVER_TO_CLIENT_DOC_KEY[docType];
      documents[clientKey] = docEntryFromLink(record[DOC_TYPE_COLUMNS[docType]]);
    });

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
    logEvent('getApplicationStatus', err.message, enrolmentNo);
    return { success: false, error: 'Something went wrong loading your application status.' };
  }
}


/* ============================================================================
   9. FIELD VALIDATION + DRIVE/DATE HELPERS
   ============================================================================ */

/** Mirrors the client-side required/optional split (see each Application*.html) — a server-side backstop, not the primary UX. */
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

function isValidEmailServer(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

/** Reads a dotted path ('localGuardian.office.tel') off a plain object; undefined if any segment is missing. */
function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function getOrCreateStudentFolder(enrolmentNo) {
  const rootIter = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER_NAME);
  const root = rootIter.hasNext() ? rootIter.next() : DriveApp.createFolder(DRIVE_ROOT_FOLDER_NAME);

  const studentIter = root.getFoldersByName(enrolmentNo);
  return studentIter.hasNext() ? studentIter.next() : root.createFolder(enrolmentNo);
}

/** One Applications cell can hold a single Drive link or a comma-joined list (Marksheets) — normalize both into a {done, files} entry, resolving real filenames from Drive. */
function docEntryFromLink(rawLink) {
  if (!rawLink) return { done: false, files: [] };
  const links = String(rawLink).split(',').map((s) => s.trim()).filter(Boolean);
  const files = links.map((url) => ({ name: getFileNameFromDriveLink(url) || 'Uploaded document', size: 0 }));
  return { done: files.length > 0, files };
}

function getFileNameFromDriveLink(url) {
  const match = String(url).match(/\/d\/([^/]+)/);
  if (!match) return null;
  try {
    return DriveApp.getFileById(match[1]).getName();
  } catch (err) {
    return null; // file moved/deleted since upload — fall back to a generic label rather than failing the whole status call
  }
}
gi