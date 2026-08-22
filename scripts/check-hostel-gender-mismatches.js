#!/usr/bin/env node
/**
 * ============================================================================
 * ONE-OFF LOCAL SCRIPT — find existing Applications rows whose HostelChoice
 * doesn't match what their Eligibility row's Gender would now produce
 * ============================================================================
 * Run this once, locally:
 *
 *   node scripts/check-hostel-gender-mismatches.js
 *
 * Why this exists: HostelChoice used to be a free client choice with no
 * server-side check against Gender (see api/submitApplication.js and
 * api/_lib/schema.js's deriveHostelFromGender() for the fix). Any row
 * submitted BEFORE that fix could have a HostelChoice that doesn't match
 * the student's actual Gender on record. This script finds those rows —
 * it does NOT modify anything, just reports.
 *
 * NOT deployed to Vercel, NOT imported by anything under /api. Requires a
 * fully populated .env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
 * GOOGLE_REFRESH_TOKEN / GOOGLE_SHEET_ID — the same four the deployed
 * functions need, see SETUP.md) since it reads the real Applications and
 * Eligibility sheets via the same _lib/sheets.js the app itself uses.
 * ============================================================================
 */

require('dotenv').config();
const { getSheetRows } = require('../api/_lib/sheets');
const { SHEET_NAMES, ELIGIBILITY_COLUMNS, APPLICATIONS_COLUMNS, deriveHostelFromGender } = require('../api/_lib/schema');

(async () => {
  try {
    const [eligibilityRows, applicationRows] = await Promise.all([
      getSheetRows(SHEET_NAMES.ELIGIBILITY, ELIGIBILITY_COLUMNS),
      getSheetRows(SHEET_NAMES.APPLICATIONS, APPLICATIONS_COLUMNS)
    ]);

    const eligByEnrolment = new Map(eligibilityRows.map((row) => [String(row.EnrolmentNo).trim(), row]));

    const mismatches = [];
    const noEligibilityRow = [];
    const unmappableGender = [];

    for (const app of applicationRows) {
      const elig = eligByEnrolment.get(String(app.EnrolmentNo).trim());
      if (!elig) {
        noEligibilityRow.push(app);
        continue;
      }
      const expected = deriveHostelFromGender(elig.Gender);
      if (!expected) {
        unmappableGender.push({ app, gender: elig.Gender });
        continue;
      }
      if (app.HostelChoice !== expected) {
        mismatches.push({ app, expected });
      }
    }

    console.log(`Checked ${applicationRows.length} Applications row(s) against ${eligibilityRows.length} Eligibility row(s).\n`);

    if (mismatches.length > 0) {
      console.log(`⚠️  ${mismatches.length} row(s) with HostelChoice mismatched against Gender:`);
      mismatches.forEach(({ app, expected }) => {
        console.log(`  - ${app.ApplicationID} (${app.EnrolmentNo}, ${app.Name}): HostelChoice="${app.HostelChoice}", expected "${expected}" from Gender on record`);
      });
      console.log('');
    } else {
      console.log('✅ No HostelChoice/Gender mismatches found.\n');
    }

    if (unmappableGender.length > 0) {
      console.log(`⚠️  ${unmappableGender.length} row(s) whose Eligibility Gender doesn't map cleanly (would now be REJECTED at submission, not silently allowed):`);
      unmappableGender.forEach(({ app, gender }) => {
        console.log(`  - ${app.ApplicationID} (${app.EnrolmentNo}, ${app.Name}): Gender="${gender || '(blank)'}"`);
      });
      console.log('');
    }

    if (noEligibilityRow.length > 0) {
      console.log(`ℹ️  ${noEligibilityRow.length} Applications row(s) with no matching Eligibility row at all (can't check these):`);
      noEligibilityRow.forEach((app) => console.log(`  - ${app.ApplicationID} (${app.EnrolmentNo}, ${app.Name})`));
      console.log('');
    }

    process.exit(mismatches.length > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nSomething went wrong reading the sheets:', err.message, '\n');
    process.exit(1);
  }
})();
