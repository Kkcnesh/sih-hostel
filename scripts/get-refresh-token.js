#!/usr/bin/env node
/**
 * ============================================================================
 * ONE-TIME LOCAL SCRIPT — obtain a Google OAuth2 refresh token
 * ============================================================================
 * Run this once, locally, on your own machine:
 *
 *   node scripts/get-refresh-token.js
 *
 * It is NOT deployed to Vercel and NOT imported by anything under /api —
 * it only exists to produce the GOOGLE_REFRESH_TOKEN value you paste into
 * Vercel's environment variables once. See SETUP.md for the full walkthrough
 * (creating the OAuth client in Cloud Console, what to do with the token
 * this prints, etc.).
 *
 * Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in a local .env file —
 * see .env.example. Reads them via the `dotenv` package (a devDependency;
 * the deployed /api functions never use dotenv, Vercel injects env vars
 * natively).
 * ============================================================================
 */

require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  // Added for the application-confirmation / allotment-letter emails
  // (_lib/mailer.js) — lets the authorized account send mail via the Gmail
  // API as itself. A refresh token generated BEFORE this scope was added
  // does not have it and cannot be upgraded in place; re-run this script
  // and replace GOOGLE_REFRESH_TOKEN in Vercel. See SETUP.md.
  'https://www.googleapis.com/auth/gmail.send'
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\nMissing GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET.');
  console.error('Create a .env file in the project root (copy .env.example) with both set,');
  console.error('using the OAuth Client ID you created in Google Cloud Console — see SETUP.md.\n');
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// access_type: 'offline' is what makes Google issue a refresh token at all
// (not just a short-lived access token). prompt: 'consent' forces the
// consent screen — and a fresh refresh token — even if this account has
// authorized this OAuth client before, since Google otherwise only issues
// a refresh token on a user's very first consent.
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES
});

console.log('\n1. Open this URL in your browser and approve access with the Google account');
console.log('   that should own the HostelDB sheet, the uploaded documents, and send the');
console.log('   confirmation/allotment emails (the consent screen will now also ask to');
console.log('   send email as this account):\n');
console.log(`   ${authUrl}\n`);
console.log('2. Waiting for the browser redirect back to this script...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404);
    res.end();
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization failed: ${error || 'no code returned'}. Check the terminal and try again.`);
    console.error(`\nAuthorization failed: ${error || 'no code returned'}\n`);
    closeAndExit(1);
    return;
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Done — you can close this tab and go back to the terminal.');

    if (!tokens.refresh_token) {
      console.log('\n⚠️  No refresh_token came back in the response.\n');
      console.log('This usually means this Google account had already authorized this exact');
      console.log('OAuth client before, and — despite prompt=consent — Google still didn\'t');
      console.log('reissue one. Revoke this app\'s access and try again:');
      console.log('  https://myaccount.google.com/permissions\n');
      closeAndExit(1);
      return;
    }

    console.log('\n✅ Success — your refresh token:\n');
    console.log(tokens.refresh_token);
    console.log('\nCopy this into Vercel: Project → Settings → Environment Variables →');
    console.log('GOOGLE_REFRESH_TOKEN. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET need to be set');
    console.log('there too (the same values from your .env file), not just used locally.');
    console.log('See SETUP.md.\n');
    closeAndExit(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Something went wrong — check the terminal.');
    console.error('\nSomething went wrong exchanging the code for tokens:', err.message, '\n');
    closeAndExit(1);
  }
});

function closeAndExit(code) {
  server.close(() => process.exit(code));
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — stop whatever else is running on it`);
    console.error('(or edit PORT at the top of this script) and try again.\n');
  } else {
    console.error('\nServer error:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT);
