/**
 * ============================================================================
 * SHARED ADMIN AUTH CHECK
 * ============================================================================
 * There's no admin login system yet — every /api/admin/* endpoint (plus
 * /api/runAllocation, which predates the admin/ folder but uses this same
 * helper) is protected by one shared secret, checked as a bearer token:
 *
 *   Authorization: Bearer <ADMIN_SECRET>
 *
 * This is intentionally the simplest thing that isn't wide open, not real
 * auth — see SETUP.md for how to generate and set ADMIN_SECRET in Vercel,
 * and admin.html for how the dashboard collects it from whoever's using it
 * (stored in sessionStorage client-side, sent as a header on every admin call).
 *
 * Call this FIRST in every admin handler, before touching any Sheets/Drive
 * data:
 *
 *   if (!requireAdmin(req, res)) return; // requireAdmin already sent the response
 *
 * It sends the 401/500 response itself (rather than just returning a
 * boolean) so every handler gets identical error bodies without repeating
 * the res.status(...).json(...) calls.
 * ============================================================================
 */

function requireAdmin(req, res) {
  // Fail CLOSED, not open — an unset ADMIN_SECRET must never be treated as
  // "no auth required."
  const expectedSecret = process.env.ADMIN_SECRET;
  if (!expectedSecret) {
    res.status(500).json({ success: false, error: 'ADMIN_SECRET is not configured on the server. See SETUP.md.' });
    return false;
  }

  const authHeader = String(req.headers.authorization || '');
  const providedSecret = (authHeader.match(/^Bearer\s+(.+)$/i) || [])[1] || '';
  if (providedSecret.trim() !== expectedSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized.' });
    return false;
  }

  return true;
}

module.exports = { requireAdmin };
