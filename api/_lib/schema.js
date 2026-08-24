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

// CategoryReservation appended 2026-08-23 to lock reservation-category
// against Eligibility instead of leaving it self-declared on the
// application form (see deriveCategoryReservation() below). getSheetRows()
// resolves columns by NAME against the live header now (see getHeaderMap()
// in _lib/sheets.js), not by position — the live Eligibility sheet's header
// row just needs this column present somewhere — see SETUP.md.
const ELIGIBILITY_COLUMNS = ['EnrolmentNo', 'Name', 'DOB', 'Course', 'School', 'Gender', 'CategoryReservation'];

const APPLICATIONS_COLUMNS = [
  'ApplicationID', 'EnrolmentNo', 'Name', 'Nationality', 'DOB', 'Course', 'School',
  'DateOfJoiningUniversity', 'CategoryResidence', 'CategoryReservation',
  'FatherName', 'MotherName',
  'EmergencyAddress', 'EmergencyTel',
  'StudentMobile', 'StudentEmail', 'ExtraCurricular',
  'HostelChoice', 'RoomTypePreference', 'RoommatePreferenceEnrolmentNo',
  'PhotoDriveLink', 'AadharDriveLink', 'MarksheetsDriveLink',
  'MedicalCertDriveLink', 'GuardianConsentDriveLink', 'AntiRaggingDriveLink',
  'SubmissionTimestamp', 'VerificationStatus', 'AllotmentStatus',
  'AllottedRoomNo', 'AllottedRoommateEnrolmentNo', 'WaitlistPosition',

  // ---- Appended 2026-08-23 for the structured-address UI redesign ----
  // getSheetRows()/writeRowAt() in _lib/sheets.js now resolve every column
  // by NAME against the live sheet's actual header row (see getHeaderMap()
  // there, fixed 2026-08-24) — so, unlike when this block was first
  // appended, column order here no longer has to match the live sheet's
  // physical order, and removing a column is no longer position-unsafe.
  //
  // Cleanup (2026-08-24): the old single-field ParentOfficeAddress/Tel/
  // Email, ParentResidenceAddress, GuardianOfficeAddress/Tel/Email, and
  // GuardianResidenceAddress/Tel/Email columns — superseded by this block's
  // structured fields below — have been REMOVED from this array entirely
  // (they used to be "kept in place, never populated" purely because
  // removing them was unsafe under the old position-based sheet access;
  // that reason is gone now). ParentResidenceTel/ParentResidenceEmail are
  // the two exceptions: they're KEPT below, still actively populated from
  // the current form's residence-address Tel/Email fields — they were
  // never replaced by anything, just joined by the 7 structured address
  // fields alongside them.
  //
  // FLAGGED, not silently dropped: the old schema separately captured
  // OFFICE and RESIDENCE contact details for both parent and guardian (6
  // fields each: address/tel/email x2 locations). The current UI (per the
  // 2026-08-23 redesign) collects only ONE address for the parent
  // ("Present Address — Residence") and ONE address for the guardian, with
  // no office/residence distinction for either, and no guardian email
  // field at all (parent office contact info — all 3 fields — has no
  // replacement; guardian email — both variants — has no replacement
  // either). The guardian side did gain fields the original schema never
  // had at all (GuardianName, GuardianRelationship, below) — so this was a
  // net restructuring, not a pure loss, but the office/residence split and
  // guardian email are genuinely gone with nothing capturing that
  // information going forward.
  'FatherPhone', 'MotherPhone', 'ParentResidenceTel', 'ParentResidenceEmail',
  'ParentResidenceHouseNo', 'ParentResidenceStreetArea', 'ParentResidenceCity',
  'ParentResidenceDistrict', 'ParentResidenceState', 'ParentResidencePincode',
  'ParentResidenceLandmark',
  // Local guardian: the UI redesign collapsed the old residence/office split
  // into a single address and dropped guardian email entirely — see the
  // FLAGGED note above and buildApplicationRow() below for what actually
  // gets populated going forward.
  'GuardianName', 'GuardianRelationship', 'GuardianPhone',
  'GuardianHouseNo', 'GuardianStreetArea', 'GuardianCity',
  'GuardianDistrict', 'GuardianState', 'GuardianPincode', 'GuardianLandmark',

  // ---- Appended 2026-08-24 for distance-based allocation tiebreaking ----
  // getSheetRows()/writeRowAt() resolve columns by NAME now (see the note
  // on the 2026-08-23 block above) — the live sheet's header row just needs
  // these two names present somewhere, order no longer matters. See SETUP.md.
  //
  // DistanceFromResidenceKm is self-declared by the student, same trust
  // model as CategoryResidence above (see buildApplicationRow() below) —
  // there's no Eligibility record to check a residence distance against,
  // so unlike CategoryReservation/HostelChoice it can't be locked/derived
  // server-side. Used by _lib/allocation.js as an intra-tier tiebreaker
  // (farther residence ranks higher, matching GGSIPU's real distance-based
  // policy) — see that file's header comment for the full policy context.
  // AddressProofDriveLink follows the exact same pattern as the six
  // Drive-link columns above — an admin cross-checks the declared distance
  // against this document manually via the existing verification toggle;
  // there is no automated geocoding/mapping check.
  'DistanceFromResidenceKm', 'AddressProofDriveLink'
];

// The only two values VerificationStatus is ever set to — confirmed against
// buildApplicationRow() below (default 'Pending') and submitApplication.js's
// existing.VerificationStatus !== 'Pending' lock check, not guessed. Used by
// api/admin/updateVerification.js to reject anything else with a 400 rather
// than writing an arbitrary string into the sheet.
const VERIFICATION_STATUSES = ['Pending', 'Verified'];

// The four values AllotmentStatus is ever set to: 'Not Processed' (default,
// see buildApplicationRow() below), 'Allotted'/'Waitlisted' (written by
// runAllocation.js via _lib/allocation.js's allocatePool()), and 'Vacated'
// — added 2026-08-24 for api/admin/vacateRoom.js, set when an admin marks a
// previously-Allotted student's room as vacated (student left permanently).
// A Vacated row is kept for record-keeping (not deleted) but is excluded
// from every future runAllocation.js run, whose candidate filter only reads
// rows still 'Not Processed' — a 'Vacated' row is neither reprocessed nor
// mistaken for a live Allotted/Waitlisted row.
const ALLOTMENT_STATUSES = ['Not Processed', 'Allotted', 'Waitlisted', 'Vacated'];

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
  AntiRagging: 'AntiRaggingDriveLink',
  AddressProof: 'AddressProofDriveLink'
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
  AntiRagging: 'antiRagging',
  AddressProof: 'addressProof'
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

/**
 * Turns a sheet row (array of cell values) into a {ColumnName: value}
 * object — looked up via `indexByName` (each column's ACTUAL physical
 * position in the live sheet's header row), never via `columns`' own
 * array order. This project's Applications/Eligibility schemas have grown
 * by appending new columns to APPLICATIONS_COLUMNS/ELIGIBILITY_COLUMNS
 * several times in one day (see the "Appended ..." comments on those
 * arrays above) — the declared array order was only ever a promise that
 * the live sheet's header would be kept in the same order, never something
 * this function itself verified. When that promise silently broke (a
 * schema change landed in code without the live sheet's header being
 * updated to match, in the same order), this used to read the right-
 * looking value from the wrong physical cell — e.g. the admin dashboard
 * showing a home address under "Hostel/Room Type". `indexByName` comes
 * from getHeaderMap() in _lib/sheets.js, which reads the sheet's real
 * header row fresh — don't "simplify" this back to positional zipping.
 */
function rowToObject(columns, rowValues, indexByName) {
  const obj = {};
  columns.forEach((col) => {
    const idx = indexByName[col];
    obj[col] = rowValues[idx] !== undefined ? rowValues[idx] : '';
  });
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

/**
 * Maps an Eligibility row's Gender value to the one hostel that student
 * may apply to. Returns null (never a default) if it doesn't map cleanly —
 * callers MUST treat null as "reject the submission," never as "assume
 * Boys." This is the actually load-bearing check — see the identical
 * client-side copy in application.html's deriveHostelFromGender(), which
 * only controls what the student sees; this is what submitApplication.js
 * actually enforces regardless of what the client sent.
 *
 * The exact set of Gender values in use in the live Eligibility sheet
 * was NOT confirmed against real data as of this change (this session had
 * no GOOGLE_REFRESH_TOKEN available to query it) — 'Male'/'Female'/'M'/'F'
 * (case-insensitive) are accepted because they're the only values any
 * existing code in this repo assumed (see the pre-existing, now-replaced
 * `student.Gender === 'Female'` check this function's client-side
 * counterpart used to be). If the real sheet uses a different convention,
 * every affected submission will be rejected with a clear error (not
 * silently mis-assigned) until this list is extended to match — confirm
 * the real values and update both this function and its client-side copy
 * together if so.
 */
function deriveHostelFromGender(gender) {
  const normalized = String(gender || '').trim().toLowerCase();
  if (normalized === 'male' || normalized === 'm') return 'Boys';
  if (normalized === 'female' || normalized === 'f') return 'Girls';
  return null;
}

// The only six reservation-category values the form/schema recognize.
const RESERVATION_CATEGORIES = ['GEN', 'SC', 'ST', 'OBC', 'EWS', 'PWD'];

/**
 * Normalizes an Eligibility row's CategoryReservation value against
 * RESERVATION_CATEGORIES, or returns null if it's blank or doesn't match
 * any of them. Trimmed + uppercased before comparing — same normalize-
 * before-compare discipline as parseSheetDate()/deriveHostelFromGender()
 * above, so an admin hand-typing " pwd" or "obc" into the sheet isn't
 * silently treated as unrecognized. This codebase has already hit this
 * exact bug class twice (DOB format mismatch, room-type casing mismatch)
 * from raw string comparisons against hand-typed sheet data — don't
 * "simplify" this back into one.
 *
 * Returns null (never a default) so the caller decides what null means —
 * see buildApplicationRow() below, which defaults null to 'GEN' rather
 * than rejecting the submission (unlike deriveHostelFromGender(), where
 * null blocks submission outright). That's a deliberate difference: not
 * every Eligibility row will have CategoryReservation pre-populated by
 * admin before this shipped, and GEN carries no allocation-priority
 * advantage, so defaulting is the safe direction to fail in.
 */
function deriveCategoryReservation(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return RESERVATION_CATEGORIES.includes(normalized) ? normalized : null;
}

/** Reads a dotted path ('residenceAddress.tel') off a plain object; undefined if any segment is missing. */
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
  // Format-check only if present — for fields the UI marks Optional (e.g.
  // Residence Email), don't require them, but still reject a garbled value.
  const optionalEmail = (path, label) => {
    const value = getPath(formData, path);
    if (value && !isValidEmailServer(value)) errors[path] = `${label} must be a valid email address.`;
  };
  const requireMobile = (path, label) => {
    requireText(path, label);
    const value = getPath(formData, path);
    if (value && !/^[6-9]\d{9}$/.test(String(value).trim())) {
      errors[path] = `${label} must be a valid 10-digit mobile number.`;
    }
  };
  // Self-declared distance (see DistanceFromResidenceKm's schema comment) —
  // upper bound of 5000 is just an obvious-typo catch (e.g. a stray zero),
  // not a real geographic limit, so it must stay loose enough for genuine
  // long-distance students (Kanyakumari to Delhi is ~2700km).
  const requireDistance = (path, label) => {
    const value = getPath(formData, path);
    if (value === undefined || value === null || String(value).trim() === '') {
      errors[path] = `${label} is required.`;
      return;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 5000) {
      errors[path] = `${label} must be a number between 1 and 5000.`;
    }
  };

  requireText('nationality', 'Nationality');
  requireText('dateOfJoining', 'Date of joining university');
  requireText('category', 'Category');
  requireDistance('distanceFromResidenceKm', 'Distance from your residence to campus');
  requireText('reservationCategory', 'Reservation category');
  requireText('fatherName', "Father's name");
  requireText('motherName', "Mother's name");
  requireMobile('fatherPhone', "Father's phone number");
  requireMobile('motherPhone', "Mother's phone number");
  // Residence address: structured (houseNo/streetArea/city/district/state/
  // pincode required, landmark optional) as of the UI redesign — replaces
  // the old single free-text 'residenceAddress.address' field. Tel/Email
  // are Optional in the current UI (downgraded from required — matches
  // what the form actually marks, not the old schema's assumption).
  requireText('residenceAddress.houseNo', 'House / Flat No.');
  requireText('residenceAddress.streetArea', 'Street / Area / Locality');
  requireText('residenceAddress.city', 'Town / City');
  requireText('residenceAddress.district', 'District');
  requireText('residenceAddress.state', 'State');
  requireText('residenceAddress.pincode', 'PIN Code');
  optionalEmail('residenceAddress.email', 'Residence email');
  requireMobile('studentMobile', 'Mobile number');
  requireEmail('studentEmail', 'Student email');
  requireText('emergencyAddress', 'Emergency contact address');
  requireText('emergencyTel', 'Emergency contact telephone number');
  // Local guardian: the UI redesign made the entire section Optional (no
  // required fields at all) and collapsed the old residence/office split
  // into one address with no guardian email — see buildApplicationRow()
  // below. Nothing to require here; left deliberately empty rather than
  // silently omitted, so a future re-introduction of a required guardian
  // field has an obvious place to go.
  requireText('hostel', 'Hostel');
  requireText('roomType', 'Room type preference');

  ['photo', 'aadhar', 'marksheets', 'medical', 'guardianConsent', 'antiRagging', 'addressProof'].forEach((key) => {
    if (!getPath(formData, `documents.${key}.driveLink`)) {
      errors[`documents.${key}`] = `The ${key} document is required.`;
    }
  });

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
    // Self-declared, like CategoryResidence just above — see this column's
    // doc comment in APPLICATIONS_COLUMNS for why it isn't locked against
    // Eligibility. Coerced to a Number (not stored as the raw string) so
    // allocation.js's sort never has to coerce a sheet-string mid-compare —
    // validateApplicationFields() above has already confirmed this parses
    // to a finite number in (0, 5000] by the time this runs.
    DistanceFromResidenceKm: Number(formData.distanceFromResidenceKm),
    // Locked/derived from Eligibility, not read from the client — same
    // override pattern as Name/DOB/Course/School/HostelChoice above. Unlike
    // HostelChoice, an unrecognized/blank value here defaults to 'GEN'
    // rather than rejecting the submission — see deriveCategoryReservation()'s
    // doc comment for why. (CategoryResidence just above stays self-declared
    // for now — deliberately out of scope for this lock, see submitApplication.js.)
    CategoryReservation: deriveCategoryReservation(elig.CategoryReservation) || 'GEN',
    FatherName: formData.fatherName,
    MotherName: formData.motherName,
    // Parent OFFICE address/tel/email and the old single-field
    // ParentResidenceAddress/GuardianOffice*/GuardianResidence* columns are
    // gone (removed from APPLICATIONS_COLUMNS 2026-08-24 — see that array's
    // comment for the full explanation and the FLAGGED information-loss
    // note). ParentResidenceTel/Email are the two residence-contact fields
    // that survive — still populated below, same as always.
    ParentResidenceTel: getPath(formData, 'residenceAddress.tel') || '',
    ParentResidenceEmail: getPath(formData, 'residenceAddress.email') || '',
    EmergencyAddress: formData.emergencyAddress,
    EmergencyTel: formData.emergencyTel,
    StudentMobile: formData.studentMobile,
    StudentEmail: formData.studentEmail,
    ExtraCurricular: formData.extraCurricular || '',
    // Ignores formData.hostel entirely, same as Name/Course/School above —
    // by the time buildApplicationRow() runs, submitApplication.js has
    // already confirmed deriveHostelFromGender(elig.Gender) is non-null
    // (see the early-return check there), so this is always a real value.
    HostelChoice: deriveHostelFromGender(elig.Gender),
    RoomTypePreference: formData.roomType,
    RoommatePreferenceEnrolmentNo: formData.roommateEnrolment || '',
    PhotoDriveLink: driveLink('photo'),
    AadharDriveLink: driveLink('aadhar'),
    MarksheetsDriveLink: driveLink('marksheets'),
    MedicalCertDriveLink: driveLink('medical'),
    GuardianConsentDriveLink: driveLink('guardianConsent'),
    AntiRaggingDriveLink: driveLink('antiRagging'),
    AddressProofDriveLink: driveLink('addressProof'),
    SubmissionTimestamp: new Date().toISOString(),
    VerificationStatus: 'Pending',
    AllotmentStatus: 'Not Processed',
    AllottedRoomNo: '',
    AllottedRoommateEnrolmentNo: '',
    WaitlistPosition: '',

    // ---- Appended 2026-08-23, see the APPLICATIONS_COLUMNS note above ----
    FatherPhone: formData.fatherPhone || '',
    MotherPhone: formData.motherPhone || '',
    ParentResidenceHouseNo: getPath(formData, 'residenceAddress.houseNo') || '',
    ParentResidenceStreetArea: getPath(formData, 'residenceAddress.streetArea') || '',
    ParentResidenceCity: getPath(formData, 'residenceAddress.city') || '',
    ParentResidenceDistrict: getPath(formData, 'residenceAddress.district') || '',
    ParentResidenceState: getPath(formData, 'residenceAddress.state') || '',
    ParentResidencePincode: getPath(formData, 'residenceAddress.pincode') || '',
    ParentResidenceLandmark: getPath(formData, 'residenceAddress.landmark') || '',
    // Local guardian is entirely Optional in the current UI and has no
    // office/residence split (and no email field) — see the validation
    // note above. All nine paths read here mirror application.html's
    // collectStep('guardian') exactly; keep both in sync if either changes.
    GuardianName: getPath(formData, 'localGuardian.name') || '',
    GuardianRelationship: getPath(formData, 'localGuardian.relationship') || '',
    GuardianPhone: getPath(formData, 'localGuardian.phone') || '',
    GuardianHouseNo: getPath(formData, 'localGuardian.address.houseNo') || '',
    GuardianStreetArea: getPath(formData, 'localGuardian.address.streetArea') || '',
    GuardianCity: getPath(formData, 'localGuardian.address.city') || '',
    GuardianDistrict: getPath(formData, 'localGuardian.address.district') || '',
    GuardianState: getPath(formData, 'localGuardian.address.state') || '',
    GuardianPincode: getPath(formData, 'localGuardian.address.pincode') || '',
    GuardianLandmark: getPath(formData, 'localGuardian.address.landmark') || ''
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
  ALLOTMENT_STATUSES,
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
  deriveHostelFromGender,
  RESERVATION_CATEGORIES,
  deriveCategoryReservation,
  isValidEmailServer,
  getPath,
  validateApplicationFields,
  buildApplicationRow,
  splitDriveLinks
};
