/**
 * Convert any Loom URL to its embed form.
 * Accepts share (https://www.loom.com/share/{id}) or embed (https://www.loom.com/embed/{id})
 * URLs and returns the embed form. Strips query params/fragments.
 * Returns null if the URL is not recognizable as a Loom video.
 */
function toLoomEmbed(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  const trimmed = rawUrl.trim();
  const match = trimmed.match(/loom\.com\/(?:share|embed)\/([a-zA-Z0-9]+)/i);
  if (!match) return null;

  return `https://www.loom.com/embed/${match[1]}`;
}

module.exports = { toLoomEmbed };
