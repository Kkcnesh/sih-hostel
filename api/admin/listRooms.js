/**
 * ============================================================================
 * POST /api/admin/listRooms
 * ============================================================================
 * Feeds the "Shift Room" selector on admin.html — returns every RoomInventory
 * row (RoomNo, Hostel, RoomType, Capacity, Occupied) so the dashboard can
 * filter client-side to the student's own Hostel+RoomType pool and show only
 * rooms with a free seat, rather than making the admin type a room number
 * blind. Admin-only (see _lib/adminAuth.js) — unlike /api/vacancy, which only
 * exposes pool-level aggregate counts (never individual room numbers) for
 * public consumption, per-room occupancy is dashboard-internal detail.
 * ============================================================================
 */

const { getSheetRows } = require('../_lib/sheets');
const { SHEET_NAMES, ROOM_INVENTORY_COLUMNS } = require('../_lib/schema');
const { requireAdmin } = require('../_lib/adminAuth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  if (!requireAdmin(req, res)) return;

  try {
    const rows = await getSheetRows(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS);

    const rooms = rows.map((row) => ({
      roomNo: row.RoomNo,
      hostel: row.Hostel,
      roomType: row.RoomType,
      capacity: Number(row.Capacity) || 0,
      occupied: Number(row.Occupied) || 0
    }));

    res.status(200).json({ success: true, rooms });
  } catch (err) {
    console.error('listRooms handler error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong loading room inventory. Please try again.' });
  }
};
