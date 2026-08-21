/* ==========================================================================
   GGSIPU HOSTEL PORTAL — SHARED CLIENT LOGIC
   ==========================================================================
   In the Apps Script build, this file becomes JavaScript.html and is
   pulled into every page via  <?!= include('JavaScript') ?>  just before
   the closing </body> tag.

   TABLE OF CONTENTS
   -----------------
   1.  Server stand-ins        (mirrors Code.gs — this is the porting map)
   2.  Session helpers         (who's logged in, right now)
   3.  Application record store (mock "Applications" sheet, one row/student)
   4.  Validation helpers
   5.  Formatting helpers
   6.  Toast / inline alerts
   7.  Document uploader component
   8.  Corridor status tracker renderer
   9.  Small icon set (inline SVG, no external assets)
   ========================================================================== */


/* ==========================================================================
   1. SERVER STAND-INS
   ==========================================================================
   Everything in the `Server` object below is a MOCKUP replacement for
   google.script.run. Each method has the exact same name as the Code.gs
   function it will call in the real build, and the exact same
   (args..., onSuccess, onFailure) shape as:

     google.script.run
       .withSuccessHandler(onSuccess)
       .withFailureHandler(onFailure)
       .functionName(args...)

   so porting a page is a find-and-replace of `Server.functionName(` with
   the google.script.run chain above — no other page logic should need
   to change.

   TODO(backend): implement the real Code.gs versions:
     - loginStudent(enrolmentNo, dob)
         Look up EnrolmentNo + DOB in the "Eligibility" sheet.
         Return { success, student } or { success:false, message }.
     - submitApplication(applicationData)
         Append a row to the "Applications" sheet (one row per student).
         This is the row the future allocation engine will read from —
         keep column order stable once real users depend on it.
         Return { success, referenceNo }.
     - uploadDocument(fileMeta)
         DriveApp.createFile(...) into a per-student folder, store the
         resulting file URL back onto the student's Applications row.
         Return { success, fileUrl }.
     - getApplicationStatus(enrolmentNo)
         Read the student's row from "Applications" (+ "Allotments" sheet
         once the allocation engine exists) and return current status.
   ========================================================================== */
const Server = {

  loginStudent(enrolmentNo, dob, onSuccess, onFailure) {
    mockLatency(() => {
      const match = MOCK_ELIGIBILITY.find(
        (row) => row.EnrolmentNo === enrolmentNo.trim() && row.DOB === dob
      );
      if (!match) {
        onFailure({
          success: false,
          message: 'We couldn’t find a match for that enrolment number and date of birth. Double-check both and try again.'
        });
        return;
      }
      onSuccess({ success: true, student: match });
    });
  },

  submitApplication(applicationData, onSuccess, onFailure) {
    mockLatency(() => {
      const referenceNo = generateReferenceNumber();
      const record = {
        ...applicationData,
        referenceNo,
        submittedDate: new Date().toISOString(),
        status: 'submitted' // submitted -> verification -> allotted | waitlisted
      };
      saveApplicationRecord(record);
      onSuccess({ success: true, referenceNo });
    }, 900);
  },

  uploadDocument(fileMeta, onSuccess, onFailure) {
    // In the real build this receives a base64 blob and calls
    // DriveApp.createFile() into a student-specific folder, then returns
    // the resulting file's URL/ID to store on the Applications row.
    mockLatency(() => {
      onSuccess({ success: true, fileName: fileMeta.name });
    }, 700 + Math.random() * 600);
  },

  getApplicationStatus(enrolmentNo, onSuccess, onFailure) {
    mockLatency(() => {
      const record = getApplicationRecord(enrolmentNo);
      if (!record) {
        onFailure({ success: false, message: 'No application found for this student yet.' });
        return;
      }
      onSuccess({ success: true, application: record });
    });
  }
};

function mockLatency(fn, delay) {
  setTimeout(fn, delay ?? 500 + Math.random() * 400);
}


/* ==========================================================================
   2. SESSION HELPERS
   ==========================================================================
   Stands in for however the real Apps Script webapp tracks "who is
   currently looking at this page" (e.g. a short-lived token in the URL,
   or Session.getActiveUser() if Google login is ever layered on top).
   Kept in sessionStorage so it clears when the browser tab closes.
   ========================================================================== */
const SESSION_KEY = 'hostelSession';

function setSession(student) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(student));
}

function getSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

/** Call at the top of application.html / status.html. Bounces to login if no session. */
function requireSession() {
  const student = getSession();
  if (!student) {
    window.location.href = 'index.html';
    return null;
  }
  return student;
}

/** Renders the sticky campus-ID-card style bar used on Application & Status pages. */
function renderIdStrip(rootEl, student) {
  const initial = student.Name.trim().charAt(0).toUpperCase();
  rootEl.innerHTML = `
    <div class="id-strip__inner">
      <div class="id-strip__chip">${initial}</div>
      <div class="id-strip__text">
        <div class="id-strip__name">${student.Name}</div>
        <div class="id-strip__meta mono">${student.EnrolmentNo} · ${student.Course}</div>
      </div>
      <button type="button" class="btn btn--ghost btn--sm id-strip__action" data-role="logout">Log out</button>
    </div>
  `;
  rootEl.querySelector('[data-role="logout"]').addEventListener('click', () => {
    clearSession();
    window.location.href = 'index.html';
  });
}


/* ==========================================================================
   3. APPLICATION RECORD STORE
   ==========================================================================
   Stands in for the "Applications" Sheet — one record per EnrolmentNo.
   Real version: a row in a Sheet, read/written via SpreadsheetApp.
   ========================================================================== */
const APPLICATIONS_KEY = 'hostelApplications';

function getAllApplications() {
  const raw = localStorage.getItem(APPLICATIONS_KEY);
  return raw ? JSON.parse(raw) : {};
}

function getApplicationRecord(enrolmentNo) {
  return getAllApplications()[enrolmentNo] || null;
}

function saveApplicationRecord(record) {
  const all = getAllApplications();
  all[record.enrolmentNo] = record;
  localStorage.setItem(APPLICATIONS_KEY, JSON.stringify(all));
}


/* ==========================================================================
   4. VALIDATION HELPERS
   ========================================================================== */
function isFilled(value) {
  return typeof value === 'string' ? value.trim().length > 0 : !!value;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isValidMobile(value) {
  return /^[6-9]\d{9}$/.test(value.trim());
}

function isValidEnrolment(value) {
  return /^\d{6,15}$/.test(value.trim());
}

/** Shows/clears a plain-language inline error under a .field wrapper. */
function setFieldError(fieldEl, message) {
  const errorEl = fieldEl.querySelector('.field__error');
  const controlEl = fieldEl.querySelector('.field__control');
  if (message) {
    fieldEl.classList.add('field--invalid');
    if (errorEl) errorEl.textContent = message;
    if (controlEl) controlEl.setAttribute('aria-invalid', 'true');
  } else {
    fieldEl.classList.remove('field--invalid');
    if (controlEl) controlEl.removeAttribute('aria-invalid');
  }
}


/* ==========================================================================
   5. FORMATTING HELPERS
   ========================================================================== */
function generateReferenceNumber() {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `GGSIPU-HST-${year}-${random}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateDisplay(isoOrDate) {
  const d = new Date(isoOrDate);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}


/* ==========================================================================
   6. TOAST / INLINE ALERTS
   ========================================================================== */
function showAlert(rootEl, { title, message, tone = 'danger' }) {
  rootEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = `alert alert--${tone}`;
  div.setAttribute('role', 'alert');
  div.innerHTML = `${icon('alert')}<div><strong>${title}</strong>${message}</div>`;
  rootEl.appendChild(div);
}

function clearAlert(rootEl) {
  rootEl.innerHTML = '';
}


/* ==========================================================================
   7. DOCUMENT UPLOADER COMPONENT
   ==========================================================================
   Builds all six document uploaders from DOCUMENT_CONFIG and wires up a
   fake-but-realistic upload flow: pick file -> validate type/size ->
   progress -> green check. Replacing a file re-runs the same flow.

   DriveApp NOTE: the actual file bytes never leave the browser in this
   mockup. In the real build, onFileSelected() below is where you'd read
   the file as base64 and call Server.uploadDocument({name, mimeType,
   base64Data}), whose Code.gs counterpart does:
     DriveApp.getFolderById(STUDENT_FOLDER_ID).createFile(blob)
   ========================================================================== */
const DOCUMENT_CONFIG = [
  { key: 'photo', label: 'Passport-size photo', required: true, accept: 'image/*', multiple: false,
    help: 'Recent photo — JPG or PNG, under 5 MB' },
  { key: 'aadhar', label: 'Aadhaar card copy', required: true, accept: 'image/*,application/pdf', multiple: false,
    help: 'Both sides — JPG, PNG or PDF, under 5 MB' },
  { key: 'marksheets', label: 'Marksheets (10th, 12th & preceding semester)', required: true, accept: 'image/*,application/pdf', multiple: true,
    help: 'You can select more than one file at once' },
  { key: 'medical', label: 'Medical certificate', required: true, accept: 'image/*,application/pdf', multiple: false,
    help: 'Issued by a registered medical practitioner' },
  { key: 'guardianConsent', label: 'Local guardian consent form', required: true, accept: 'image/*,application/pdf', multiple: false,
    help: 'Signed by your local guardian' },
  { key: 'antiRagging', label: 'Anti-Ragging affidavit', required: true, accept: 'image/*,application/pdf', multiple: false,
    help: 'Downloadable from the UGC Anti-Ragging portal' }
];

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Renders every configured uploader into containerEl and wires interaction.
 * Returns { getState, onChange } so the page can gate the submit button.
 */
function renderUploaders(containerEl, onChangeCallback) {
  const state = {}; // key -> { done: bool, files: [{name, size}] }

  DOCUMENT_CONFIG.forEach((cfg) => {
    state[cfg.key] = { done: false, files: [] };
    containerEl.appendChild(buildUploaderNode(cfg, state, onChangeCallback));
  });

  return {
    getState: () => state,
    allRequiredDone: () => DOCUMENT_CONFIG.every((c) => !c.required || state[c.key].done)
  };
}

function buildUploaderNode(cfg, state, onChangeCallback) {
  const wrap = document.createElement('div');
  wrap.className = 'uploader';
  wrap.id = `uploader-${cfg.key}`;

  const tag = cfg.required
    ? '<span class="field__tag field__tag--required">Required</span>'
    : '<span class="field__tag field__tag--optional">Optional</span>';

  wrap.innerHTML = `
    <div class="uploader__icon" data-role="icon">${icon('doc')}</div>
    <div class="uploader__body">
      <div class="uploader__title">${cfg.label} ${tag}</div>
      <div class="uploader__filename" data-role="filename"></div>
      <div class="uploader__status" data-role="status">${cfg.help}</div>
      <div class="uploader__progress"><div class="uploader__progress-bar" data-role="progress-bar"></div></div>
    </div>
    <div class="uploader__action">
      <button type="button" class="btn btn--secondary btn--sm" data-role="trigger">Choose file</button>
      <input type="file" data-role="input" accept="${cfg.accept}" ${cfg.multiple ? 'multiple' : ''}>
    </div>
  `;

  const input = wrap.querySelector('[data-role="input"]');
  const trigger = wrap.querySelector('[data-role="trigger"]');
  const filenameEl = wrap.querySelector('[data-role="filename"]');
  const statusEl = wrap.querySelector('[data-role="status"]');
  const iconEl = wrap.querySelector('[data-role="icon"]');
  const progressBar = wrap.querySelector('[data-role="progress-bar"]');

  trigger.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    if (files.length === 0) return;

    const invalid = files.find((f) => f.size > MAX_FILE_BYTES);
    if (invalid) {
      statusEl.textContent = `"${invalid.name}" is over 5 MB — choose a smaller file.`;
      wrap.classList.add('uploader--error');
      return;
    }
    wrap.classList.remove('uploader--error', 'uploader--done');
    wrap.classList.add('uploader--uploading');

    filenameEl.textContent = files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(', ');
    statusEl.textContent = 'Uploading…';
    progressBar.style.width = '0%';

    // Fake progress ramp so the state change reads as an upload, not a toggle.
    let pct = 0;
    const ramp = setInterval(() => {
      pct = Math.min(pct + 18 + Math.random() * 20, 92);
      progressBar.style.width = `${pct}%`;
    }, 120);

    // Stand-in for Server.uploadDocument(...) per-file; see file header note.
    Server.uploadDocument({ name: files[0].name }, () => {
      clearInterval(ramp);
      progressBar.style.width = '100%';
      wrap.classList.remove('uploader--uploading');
      wrap.classList.add('uploader--done');
      iconEl.innerHTML = icon('check');
      statusEl.textContent = files.length > 1 ? `${files.length} files uploaded` : 'Uploaded';
      trigger.textContent = 'Replace';

      state[cfg.key] = { done: true, files: files.map((f) => ({ name: f.name, size: f.size })) };
      onChangeCallback?.();
    });
  });

  return wrap;
}


/* ==========================================================================
   8. CORRIDOR STATUS TRACKER RENDERER
   ==========================================================================
   Signature element for Status.html: three stages rendered as numbered
   doors along a hallway. statusKey is one of:
     'submitted' | 'verification' | 'allotted' | 'waitlisted'
   ========================================================================== */
function renderCorridor(containerEl, statusKey) {
  const stage3Label = statusKey === 'waitlisted' ? 'Waitlisted'
    : statusKey === 'allotted' ? 'Allotted'
    : 'Allotted / Waitlisted';

  const stages = [
    { n: 1, label: 'Submitted' },
    { n: 2, label: 'Under Verification' },
    { n: 3, label: stage3Label }
  ];

  const activeIndex = { submitted: 0, verification: 1, allotted: 2, waitlisted: 2 }[statusKey] ?? 0;
  const fillPct = [0, 50, 100][activeIndex];

  containerEl.innerHTML = `
    <div class="corridor__line">
      <div class="corridor__line-fill" style="width:${fillPct}%"></div>
    </div>
    <div class="corridor__doors">
      ${stages.map((s, i) => {
        const doorState = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
        const frameContent = doorState === 'done' ? icon('check') : s.n;
        return `
          <div class="door door--${doorState}">
            <div class="door__frame">${frameContent}</div>
            <div class="door__label">${s.label}</div>
          </div>`;
      }).join('')}
    </div>
  `;
}


/* ==========================================================================
   9. ICON SET  (inline SVG — no external icon library)
   ========================================================================== */
function icon(name) {
  switch (name) {
    case 'check':
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8.5L6.2 11.5L13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    case 'doc':
      return '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 2h7l3 3v11H4V2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M11 2v3h3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    case 'alert':
      return '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" style="flex-shrink:0"><circle cx="9" cy="9" r="7.5" stroke="currentColor" stroke-width="1.5"/><path d="M9 5.5v4.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="12.3" r="0.9" fill="currentColor"/></svg>';
    default:
      return '';
  }
}
