/**
 * ============================================================================
 * GET /api/vacancy
 * ============================================================================
 * Public — deliberately NO requireAdmin() / login check. This is the app's
 * answer to the problem statement's own stated pain point ("limited
 * transparency for students and parents"): anyone (students, parents,
 * judges) can load this with zero authentication and see live seat
 * availability.
 *
 * Deliberately narrow in what it exposes: aggregate capacity/occupied/
 * vacant counts per Hostel x RoomType pool ONLY — never individual room
 * numbers, and nothing tied to any student or application. Read-only, one
 * Sheets read, no writes — doesn't touch Applications, allocation, or any
 * existing schema.
 *
 * Response shape: {success: true, pools: [{hostel, roomType, capacity,
 * occupied, vacant}, ...]} or {success: false, error}.
 * ============================================================================
 */

const { getSheetRows } = require('./_lib/sheets');
const { SHEET_NAMES, ROOM_INVENTORY_COLUMNS } = require('./_lib/schema');
const { HOSTELS, ROOM_TYPES } = require('./_lib/allocation');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const roomRows = await getSheetRows(SHEET_NAMES.ROOM_INVENTORY, ROOM_INVENTORY_COLUMNS);

    // Same 4 pools _lib/allocation.js allocates seats into — reusing
    // HOSTELS/ROOM_TYPES from there (rather than re-listing "Boys"/"Girls"/
    // "Triple-sharing"/"4-sharing" again here) keeps this endpoint's pools
    // automatically in sync if the allocation policy's pools ever change.
    const pools = HOSTELS.flatMap((hostel) =>
      ROOM_TYPES.map((roomType) => {
        const poolRooms = roomRows.filter((r) => r.Hostel === hostel && r.RoomType === roomType);
        const capacity = poolRooms.reduce((sum, r) => sum + (Number(r.Capacity) || 0), 0);
        const occupied = poolRooms.reduce((sum, r) => sum + (Number(r.Occupied) || 0), 0);
        // Clamped per-room before summing (same Math.max(0, ...) idiom as
        // allocatePool()'s room-remaining calc in _lib/allocation.js) so a
        // hand-edited sheet with Occupied > Capacity on one room can't make
        // this pool's vacant count negative.
        const vacant = poolRooms.reduce((sum, r) => sum + Math.max(0, (Number(r.Capacity) || 0) - (Number(r.Occupied) || 0)), 0);
        return { hostel, roomType, capacity, occupied, vacant };
      })
    );

    res.status(200).json({ success: true, pools });
  } catch (err) {
    console.error('vacancy handler error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong loading vacancy data. Please try again.' });
  }
};
