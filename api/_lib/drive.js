/**
 * ============================================================================
 * GOOGLE DRIVE CLIENT + FOLDER/FILE HELPERS
 * ============================================================================
 * Shares the same OAuth2 (refresh-token) auth as sheets.js — see getAuth()
 * there. Files upload into and folders get created in whichever Google
 * account authorized that refresh token (see scripts/get-refresh-token.js
 * and SETUP.md) — files are organized as
 * "Hostel Applications/<EnrolmentNo>/<file>", found by NAME rather than a
 * stored folder ID, same structure the project's original Apps Script
 * backend used.
 *
 * Files are never made public: Drive API v3 files are private by default
 * (visible only to the authorizing account, and to anyone that account
 * separately shares them with) unless a permission is explicitly added via
 * drive.permissions.create — which nothing here ever does.
 * ============================================================================
 */

const { google } = require('googleapis');
const { Readable } = require('stream');
const { getAuth } = require('./sheets');
const { DRIVE_ROOT_FOLDER_NAME } = require('./schema');

let cachedDriveClient = null;

function getDriveClient() {
  if (!cachedDriveClient) {
    cachedDriveClient = google.drive({ version: 'v3', auth: getAuth() });
  }
  return cachedDriveClient;
}

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/** Finds a folder by exact name under `parentId` (or anywhere the authorizing account can see, if parentId is null), or creates it. "First match wins" if more than one folder shares the name. */
async function findOrCreateFolder(name, parentId) {
  const drive = getDriveClient();

  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false${parentClause}`;

  const listRes = await drive.files.list({
    q,
    fields: 'files(id, name)',
    spaces: 'drive'
  });

  if (listRes.data.files && listRes.data.files.length > 0) {
    return listRes.data.files[0].id;
  }

  const createRes = await drive.files.create({
    resource: {
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: parentId ? [parentId] : undefined
    },
    fields: 'id'
  });
  return createRes.data.id;
}

/** "Hostel Applications/<EnrolmentNo>/" — same two-level structure as Code.gs's getOrCreateStudentFolder(). */
async function getOrCreateStudentFolder(enrolmentNo) {
  const rootId = await findOrCreateFolder(DRIVE_ROOT_FOLDER_NAME, null);
  const studentFolderId = await findOrCreateFolder(enrolmentNo, rootId);
  return studentFolderId;
}

/**
 * Uploads one file (raw bytes, not base64) into `folderId`. Returns the
 * same shape Code.gs's uploadDocument() built from `file.getUrl()`/
 * `file.getId()` — webViewLink is the same "open in Drive" URL format
 * (`https://drive.google.com/file/d/FILE_ID/view?...`) that
 * getFileNameFromDriveLink()'s regex already expects.
 */
async function uploadFile({ folderId, fileName, mimeType, buffer }) {
  const drive = getDriveClient();

  const res = await drive.files.create({
    resource: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType,
      body: Readable.from(buffer)
    },
    fields: 'id, webViewLink'
  });

  return { fileId: res.data.id, fileUrl: res.data.webViewLink };
}

/** Resolves a Drive file's current display name from a webViewLink-style URL — null if the link doesn't parse or the file's gone (moved/deleted since upload), matching Code.gs's fallback-to-generic-label behavior. */
async function getFileNameFromDriveLink(url) {
  const match = String(url).match(/\/d\/([^/]+)/);
  if (!match) return null;

  try {
    const drive = getDriveClient();
    const res = await drive.files.get({ fileId: match[1], fields: 'name' });
    return res.data.name || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  getDriveClient,
  getOrCreateStudentFolder,
  uploadFile,
  getFileNameFromDriveLink
};
