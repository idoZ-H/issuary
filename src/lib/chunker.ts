// Splits repo source files into overlapping line-window chunks for embedding.
//
// The Chunker interface is the pluggable seam for retrieval quality: the
// concrete strategy (line windows vs. symbol-boundary vs. tree-sitter-WASM) is
// an open research question. Swapping the implementation is localized to this
// file plus a CHUNKER_VERSION bump — the manifest's chunker_version field then
// triggers a lazy rebuild of any index built by an older strategy.
//
// tree-sitter's native binding does NOT run inside a Cloudflare Worker, so the
// starter strategy is language-agnostic line windows with overlap. Overlap
// preserves context that would otherwise be cut at a chunk boundary.

// Bumped to v2: index now covers large files (raised file-size cap) and
// excludes docs/markdown — both change which content is indexed, so existing
// indexes must rebuild.
export const CHUNKER_VERSION = "linewin-v2";

export interface CodeChunk {
  path: string;
  start_line: number; // 1-based, inclusive
  end_line: number; // 1-based, inclusive
  text: string;
}

export interface Chunker {
  readonly version: string;
  chunk(content: string, path: string): CodeChunk[];
}

const DEFAULT_WINDOW = 60;
const DEFAULT_OVERLAP = 15;

export class LineWindowChunker implements Chunker {
  readonly version = CHUNKER_VERSION;

  constructor(
    private readonly window = DEFAULT_WINDOW,
    private readonly overlap = DEFAULT_OVERLAP
  ) {}

  chunk(content: string, path: string): CodeChunk[] {
    if (!content || content.trim().length === 0) return [];
    const lines = content.split("\n");
    const step = Math.max(1, this.window - this.overlap);
    const chunks: CodeChunk[] = [];

    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(lines.length, start + this.window);
      const text = lines.slice(start, end).join("\n");
      if (text.trim().length > 0) {
        chunks.push({ path, start_line: start + 1, end_line: end, text });
      }
      if (end >= lines.length) break;
    }

    return chunks;
  }
}
