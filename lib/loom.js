/**
 * Convert any Loom URL to its embed form.
 * Accepts share (https://www.loom.com/share/{id}) or embed (https://www.loom.com/embed/{id})
 * URLs. Returns the embed form with player chrome cleaned up:
 *   - hide_owner: don't show recorder's name
 *   - hide_share: don't surface share button
 *   - hide_title: drop title bar
 *   - hideEmbedTopBar: collapse top bar entirely
 *   - hide_speed: hide playback-speed control (note: per-user cached
 *     speed preference still applies on Loom's side)
 * Returns null if the URL is not recognizable as a Loom video.
 */
function toLoomEmbed(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  const trimmed = rawUrl.trim();
  const match = trimmed.match(/loom\.com\/(?:share|embed)\/([a-zA-Z0-9]+)/i);
  if (!match) return null;

  const params = new URLSearchParams({
    hide_owner: 'true',
    hide_share: 'true',
    hide_title: 'true',
    hideEmbedTopBar: 'true',
    hide_speed: 'true',
  });
  return `https://www.loom.com/embed/${match[1]}?${params.toString()}`;
}

module.exports = { toLoomEmbed };
