  /* ==========================================================================
    GGSIPU HOSTEL PORTAL — SHARED CLIENT LOGIC
    ==========================================================================
    Linked from every page via <script src="js/script.js"></script> just
    before the closing body tag.

    BACKEND NOTE: this app now talks to Vercel Serverless Functions under
    /api/* (Google Sheets API + Drive API, service-account auth) instead of
    Google Apps Script — see callApi() below. It previously ran inside Apps
    Script's HTML Service, whose sandboxed iframe blocked any
    script-triggered top-level navigation (only a real, user-clicked
    <a href> was ever safe). That constraint is gone now that this is a
    plain static site, but the patterns it produced — requireSession()
    returning null instead of redirecting, renderGatePanel() rendering a
    real link instead of forcing navigation, plain <div>s instead of <form>
    elements — are left exactly as they were; they still work correctly and
    changing them is a UI/behavior change, not a transport one.

    TABLE OF CONTENTS
    -----------------
    1.  Navigation + server-call helpers (pageUrl, callApi, runServer)
    2.  Session helpers         (who's logged in, right now)
    3.  Gate panel renderer     (real-link "go here instead" states)
    4.  Site header / footer renderer (shared chrome on every page)
    5.  Application draft store (in-progress wizard answers)
    6.  Validation helpers
    7.  Formatting helpers
    8.  Toast / inline alerts
    9.  Document uploader component (real Drive uploads via uploadDocument)
    10. Step wizard nav renderer
    11. Corridor status tracker renderer
    12. Small icon set (inline SVG, no external assets)
    ========================================================================== */


  /* ==========================================================================
    1. NAVIGATION + SERVER-CALL HELPERS
    ========================================================================== */

  /** Every internal link is a real static file now — see /api/_lib and vercel's default routing (index.html | application.html | status.html). */
  const PAGE_FILES = {
    login: 'index.html',
    application: 'application.html',
    status: 'status.html',
    vacancy: 'vacancy.html'
  };

  function pageUrl(key) {
    return PAGE_FILES[key] || PAGE_FILES.login;
  }

  /**
   * POSTs JSON to /api/<endpoint> and resolves with the parsed response
   * body — including a {success:false, ...} result, same as before.
   * Rejects only on a network failure or a non-2xx HTTP status (an
   * unhandled server exception), mirroring google.script.run's
   * withFailureHandler firing only on a thrown server error. Callers still
   * check `.success` themselves on the resolved value.
   */
  function callApi(endpoint, payload) {
    return fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res.json();
    });
  }

  /** Thin alias used by the document uploader, which already `await`s its server calls — see section 9. */
  function runServer(endpoint, payload) {
    return callApi(endpoint, payload);
  }


  /* ==========================================================================
    2. SESSION HELPERS
    ==========================================================================
    The session object is whatever loginStudent() returned as `student`,
    plus `hasExistingApplication` / `applicationId` merged in at login time
    (and updated again right after a successful submitApplication() call —
    see Application.html). Kept in sessionStorage so it clears when the tab
    closes; there's no server-side session, since login here is an
    enrolment+DOB check, not real Google account auth.
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

  /**
   * Call at the top of Application.html / Status.html. Does NOT redirect —
   * see the NAVIGATION RULE above — it just reports whether there's a
   * session so the caller can render a gate panel (real link to Login) if
   * not.
   */
  function requireSession() {
    return getSession();
  }

  /** Where "Apply for Hostel" / a fresh login should land. */
  function applicationEntryUrl(student) {
    return student.hasExistingApplication ? pageUrl('status') : pageUrl('application');
  }


  /* ==========================================================================
    3. GATE PANEL RENDERER
    ==========================================================================
    The shared shape for every "you need to be somewhere else" state: not
    logged in, already have an application, application not found yet, etc.
    Always a real <a href>, never a script-triggered redirect — see the
    NAVIGATION RULE at the top of this file for why.
    ========================================================================== */
  function renderGatePanel(rootEl, { title, message, linkHref, linkLabel }) {
    rootEl.innerHTML = `
      <div class="panel empty-state">
        <div class="empty-state__icon">${icon('doc')}</div>
        <h2 style="font-size: var(--text-lg);">${title}</h2>
        <p class="text-muted" style="margin-top: 4px;">${message}</p>
        <a href="${linkHref}" class="btn btn--primary" style="margin-top: var(--space-4);">${linkLabel}</a>
      </div>
    `;
  }


  /* ==========================================================================
    4. SITE HEADER / FOOTER RENDERER
    ==========================================================================
    Shared chrome for every page — matches the university's own subsite
    header structure (slim navy utility row, bolder row with the crest and
    bold orange section links). Rendered from JS rather than split into
    Header.html/Footer.html partials because the "logged in" parts (name,
    Log Out, which nav items apply) depend on sessionStorage, which server
    templates can't see at render time — there's no server-side session here.

    Log Out is a real <a href> (not a button with a JS redirect) so its
    navigation is a genuine click, not a script-triggered one — see the
    NAVIGATION RULE at the top of this file. clearSession() runs in the
    click handler but never calls preventDefault(), so the browser still
    follows the link's own href immediately afterward.
    ========================================================================== */
  function renderSiteHeader(rootEl, { activeNav = null } = {}) {
  const student = getSession();

  const utilityRight = student
    ? `
        <div class="site-header__student">
          <div class="site-header__avatar">
            ${String(student.Name || 'S').trim().charAt(0).toUpperCase()}
          </div>

          <div class="site-header__student-info">
            <div class="site-header__student-name">${student.Name}</div>
            <div class="site-header__student-id">Enrolment · ${student.EnrolmentNo}</div>
          </div>
        </div>

        <a href="${pageUrl('login')}" data-role="logout">Log Out</a>
      `
        : `
        <a href="${pageUrl('login')}">Home</a>
        <a href="admin.html">Admin Login</a>
      `;

  // Check Vacancy is public (no login) — see api/vacancy.js — so it's
  // shown in both nav variants below, logged in or not, not tucked behind
  // a session check like Apply/Track Status.
  const vacancyLink = `<a href="${pageUrl('vacancy')}" ${activeNav === 'vacancy' ? 'aria-current="page"' : ''}>Check Vacancy</a>`;

  const navLinks = student
    ? `
        <a href="${applicationEntryUrl(student)}" ${activeNav === 'apply' ? 'aria-current="page"' : ''}>Apply for Hostel</a>
        <a href="${pageUrl('status')}" ${activeNav === 'status' ? 'aria-current="page"' : ''}>Track Status</a>
        ${vacancyLink}
      `
    : `
        <a href="${pageUrl('login')}" ${activeNav === 'login' ? 'aria-current="page"' : ''}>Student Login</a>
        ${vacancyLink}
      `;

  rootEl.innerHTML = `
    <div class="site-header__main">
      <div class="site-header__brand">
        <div class="site-header__crest">
          <img src="assets/GGSIPU-logo.png" alt="GGSIPU Logo">
        </div>

        <div class="site-header__titles">
          <div class="site-header__org">
            Guru Gobind Singh Indraprastha University
          </div>
          <div class="site-header__sub">
            Hostel Allocation Portal
          </div>
        </div>
      </div>

      <nav class="site-nav">
        ${utilityRight}
        ${navLinks}
      </nav>
    </div>
  `;

  rootEl.querySelector('[data-role="logout"]')?.addEventListener('click', () => {
    clearSession();
  });
}

  function renderSiteFooter(rootEl) {
    rootEl.innerHTML = `
      <div class="site-footer__inner">GURU GOBIND SINGH INDRAPRASTHA UNIVERSITY — HOSTEL ALLOCATION PORTAL</div>
    `;
  }


  /* ==========================================================================
    5. APPLICATION DRAFT STORE
    ==========================================================================
    Holds in-progress answers as a student moves through the 6 application
    steps inside Application.html (a single page load — see that file's
    step controller), before final submission. Also stores `currentStep` so
    a mid-application page refresh resumes on the right step instead of
    restarting at step 1. Only turns into a real Applications row when the
    Review step calls submitApplication().

    TODO(backend): a production version should persist this server-side too
    (e.g. a PropertiesService-backed draft) so a student who closes the tab
    mid-application doesn't lose their answers — sessionStorage alone only
    survives within one browser tab session.
    ========================================================================== */
  const DRAFT_KEY = 'hostelApplicationDraft';

  function getDraft() {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function saveDraftFields(fields) {
    const draft = { ...(getDraft() || {}), ...fields };
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    return draft;
  }

  function clearDraft() {
    sessionStorage.removeItem(DRAFT_KEY);
  }


  /* ==========================================================================
    6. VALIDATION HELPERS
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

  // Upper bound of 5000 mirrors validateApplicationFields()'s server-side
  // check (api/_lib/schema.js) — an obvious-typo catch, not a real
  // geographic limit, so it stays loose enough for genuine long-distance
  // students rather than blocking real applications.
  function isValidDistance(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 && numeric <= 5000;
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
    7. FORMATTING HELPERS
    ========================================================================== */
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
    8. TOAST / INLINE ALERTS
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
    9. DOCUMENT UPLOADER COMPONENT
    ==========================================================================
    Builds every document uploader from DOCUMENT_CONFIG and wires up a
    real upload: read the file as base64 in the browser, send it to
    uploadDocument() (Code.gs), which drops it into the student's Drive
    folder and returns the file's URL. Marksheets allows multiple files —
    each is uploaded with its own uploadDocument() call and the returned
    links are joined into one comma-separated string, since the Applications
    sheet has a single MarksheetsDriveLink cell.
    ========================================================================== */
  const DOCUMENT_CONFIG = [
    { key: 'photo', serverDocType: 'Photo', label: 'Passport-size photo', required: true, accept: 'image/*', multiple: false,
      help: 'Recent photo — JPG or PNG, under 5 MB' },
    { key: 'aadhar', serverDocType: 'Aadhar', label: 'Aadhaar card copy', required: true, accept: 'image/*,application/pdf', multiple: false,
      help: 'Both sides — JPG, PNG or PDF, under 5 MB' },
    { key: 'marksheets', serverDocType: 'Marksheets', label: 'Marksheets (12th & preceding semester)', required: true, accept: 'image/*,application/pdf', multiple: false,
      help: 'You can select more than one file at once' },
    { key: 'medical', serverDocType: 'MedicalCert', label: 'Medical certificate (PDF)', required: true, accept: 'image/*,application/pdf', multiple: false,
      help: 'Issued by a registered medical practitioner' },
    { key: 'guardianConsent', serverDocType: 'GuardianConsent', label: 'Parent consent form (PDF)', required: true, accept: 'image/*,application/pdf', multiple: false,
      help: 'Signed by your local guardian' },
    { key: 'antiRagging', serverDocType: 'AntiRagging', label: 'Anti-Ragging affidavit (PDF)', required: true, accept: 'image/*,application/pdf', multiple: false,
      help: 'Downloadable from the UGC Anti-Ragging portal' },
    { key: 'addressProof', serverDocType: 'AddressProof', label: 'Address proof (PDF)', required: true, accept: 'image/*,application/pdf', multiple: false,
      help: 'Electricity, water, telephone or piped-gas bill — not older than 3 months' }
  ];

  const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — Code.gs enforces this again server-side, don't only trust this check

  /** FileReader wrapped as a promise, stripped down to just the base64 payload (no "data:...;base64," prefix). */
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Renders every configured uploader into containerEl and wires interaction.
   * `prefill` (optional) is a key -> {done, files, driveLink} map — e.g. from
   * a saved draft — so a student returning to this step sees earlier uploads
   * still marked done instead of being asked to re-attach them.
   * Returns { getState, allRequiredDone } so the page can gate the submit button.
   */
  function renderUploaders(containerEl, onChangeCallback, prefill = {}, enrolmentNo) {
    const state = {}; // key -> { done: bool, files: [{name, size}], driveLink: string }

    DOCUMENT_CONFIG.forEach((cfg) => {
      state[cfg.key] = prefill[cfg.key]?.done
        ? { done: true, files: prefill[cfg.key].files, driveLink: prefill[cfg.key].driveLink }
        : { done: false, files: [], driveLink: '' };
      containerEl.appendChild(buildUploaderNode(cfg, state, onChangeCallback, enrolmentNo));
    });

    return {
      getState: () => state,
      allRequiredDone: () => DOCUMENT_CONFIG.every((c) => !c.required || state[c.key].done)
    };
  }

  function buildUploaderNode(cfg, state, onChangeCallback, enrolmentNo) {
    const wrap = document.createElement('div');
    wrap.className = 'uploader';
    wrap.id = `uploader-${cfg.key}`;

    const tag = cfg.required
  ? '<span class="field__required">*</span>'
  : '<span class="field__tag field__tag--optional">Optional</span>';

    const already = state[cfg.key];
    const startDone = already.done;

    wrap.innerHTML = `
      <div class="uploader__icon" data-role="icon">${icon(startDone ? 'check' : 'doc')}</div>
      <div class="uploader__body">
        <div class="uploader__title">${cfg.label} ${tag}</div>
        <div class="uploader__filename" data-role="filename">${startDone ? already.files.map((f) => f.name).join(', ') : ''}</div>
        <div class="uploader__status" data-role="status">${startDone ? (already.files.length > 1 ? `${already.files.length} files uploaded` : 'Uploaded') : cfg.help}</div>
        <div class="uploader__progress"><div class="uploader__progress-bar" data-role="progress-bar"></div></div>
      </div>
      <div class="uploader__action">
        <button type="button" class="btn btn--secondary btn--sm" data-role="trigger">${startDone ? 'Replace' : 'Choose file'}</button>
        <input type="file" data-role="input" accept="${cfg.accept}" ${cfg.multiple ? 'multiple' : ''}>
      </div>
    `;
    if (startDone) wrap.classList.add('uploader--done');

    const input = wrap.querySelector('[data-role="input"]');
    const trigger = wrap.querySelector('[data-role="trigger"]');
    const filenameEl = wrap.querySelector('[data-role="filename"]');
    const statusEl = wrap.querySelector('[data-role="status"]');
    const iconEl = wrap.querySelector('[data-role="icon"]');
    const progressBar = wrap.querySelector('[data-role="progress-bar"]');

    trigger.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
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

      // Perceived-progress ramp — this fetch() is one atomic round trip
      // with no real byte-level progress events, so this just signals "still
      // working" rather than tracking an actual percentage.
      let pct = 0;
      const ramp = setInterval(() => {
        pct = Math.min(pct + 8 + Math.random() * 10, 92);
        progressBar.style.width = `${pct}%`;
      }, 150);

      try {
        const driveLinks = [];
        for (const file of files) {
          const base64 = await readFileAsBase64(file);
          const result = await runServer('uploadDocument', {
            enrolmentNo,
            docType: cfg.serverDocType,
            base64Data: base64,
            fileName: file.name,
            mimeType: file.type
          });
          if (!result.success) throw new Error(result.error || 'Upload failed.');
          driveLinks.push(result.fileUrl);
        }

        clearInterval(ramp);
        progressBar.style.width = '100%';
        wrap.classList.remove('uploader--uploading');
        wrap.classList.add('uploader--done');
        iconEl.innerHTML = icon('check');
        statusEl.textContent = files.length > 1 ? `${files.length} files uploaded` : 'Uploaded';
        trigger.textContent = 'Replace';

        state[cfg.key] = {
          done: true,
          files: files.map((f) => ({ name: f.name, size: f.size })),
          driveLink: driveLinks.join(', ')
        };
        onChangeCallback?.();
      } catch (err) {
        clearInterval(ramp);
        wrap.classList.remove('uploader--uploading');
        wrap.classList.add('uploader--error');
        statusEl.textContent = err.message || 'Upload failed — please try again.';
      }
    });

    return wrap;
  }


  /* ==========================================================================
    10. STEP WIZARD NAV RENDERER
    ==========================================================================
    The numbered progress bar shown at the top of the Application page
    (1 Personal -> ... -> 6 Review). Purely a progress readout — the items
    aren't clickable; Application.html's own step controller (Next/Back
    buttons) is what actually moves between steps.
    ========================================================================== */
  const APPLICATION_STEPS = [
    { key: 'personal', label: 'Personal' },
    { key: 'family', label: 'Family' },
    { key: 'guardian', label: 'Guardian' },
    { key: 'hostel', label: 'Hostel' },
    { key: 'documents', label: 'Documents' },
    { key: 'review', label: 'Review' }
  ];

  function renderStepNav(rootEl, currentKey) {
    const currentIndex = APPLICATION_STEPS.findIndex((s) => s.key === currentKey);
    rootEl.innerHTML = APPLICATION_STEPS.map((step, i) => {
      const state = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'upcoming';
      const num = state === 'done' ? icon('check') : i + 1;
      return `
        <div class="step-nav__item step-nav__item--${state}">
          <div class="step-nav__num">${num}</div>
          <div class="step-nav__label">${step.label}</div>
        </div>`;
    }).join('');
  }


  /* ==========================================================================
    11. CORRIDOR STATUS TRACKER RENDERER
    ==========================================================================
    Signature element for Status.html: three stages rendered as numbered
    doors along a hallway. statusKey is one of:
      'submitted' | 'verification' | 'allotted' | 'waitlisted' | 'vacated'
    (derived server-side data -> this key by deriveCorridorStatus() in
    Status.html, since VerificationStatus/AllotmentStatus are two separate
    columns, not one).
    ========================================================================== */
  function renderCorridor(containerEl, statusKey) {
    const stage3Label = statusKey === 'waitlisted' ? 'Waitlisted'
      : statusKey === 'allotted' ? 'Allotted'
      : statusKey === 'vacated' ? 'Vacated'
      : 'Allotted / Waitlisted';

    const stages = [
      { n: 1, label: 'Submitted' },
      { n: 2, label: 'Under Verification' },
      { n: 3, label: stage3Label }
    ];

    const activeIndex = { submitted: 0, verification: 1, allotted: 2, waitlisted: 2, vacated: 2 }[statusKey] ?? 0;
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
    12. ICON SET  (inline SVG — no external icon library)
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
