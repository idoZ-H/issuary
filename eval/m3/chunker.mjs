// Faithful port of src/lib/chunker.ts (LineWindowChunker, linewin-v2) and the
// isExcludedFromCodeIndex filter, so the eval indexer produces the SAME chunk set
// as production while running under bare node. Parity is enforced by
// tests/unit/eval-m3-chunker-parity.test.mjs — keep them in lockstep.

const WINDOW = 60;
const OVERLAP = 15;

/**
 * @param {string} content
 * @param {string} path
 * @returns {{path: string, start_line: number, end_line: number, text: string}[]}
 */
export function chunkFile(content, path) {
  if (!content || content.trim().length === 0) return [];
  const lines = content.split("\n");
  const step = Math.max(1, WINDOW - OVERLAP);
  const chunks = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + WINDOW);
    const text = lines.slice(start, end).join("\n");
    if (text.trim().length > 0) {
      chunks.push({ path, start_line: start + 1, end_line: end, text });
    }
    if (end >= lines.length) break;
  }
  return chunks;
}

// Mirror of isExcludedFromCodeIndex in src/pipeline/code-index.ts. Keep in
// lockstep — tests/unit/eval-m3-chunker-parity.test.mjs cross-checks both.
const EXCLUDED_EXTENSIONS =
  /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|tiff?|woff2?|ttf|otf|eot|pdf|xlsx?|docx?|pptx?|zip|tar|t?gz|bz2|rar|7z|mp4|mp3|wav|mov|avi|webm|m4a|ogg|log|dump|diff|csv|tsv)$/i;
const MINIFIED_OR_BUNDLE = /\.(?:min\.(?:js|css)|bundle\.js)$/i;
const EXCLUDED_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "diff.txt",
]);

/** @param {string} path @returns {boolean} */
export function isExcluded(path) {
  if (/(^|\/)docs\//i.test(path) || /\.(md|markdown|mdx)$/i.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (EXCLUDED_BASENAMES.has(basename)) return true;
  return MINIFIED_OR_BUNDLE.test(path) || EXCLUDED_EXTENSIONS.test(path);
}
