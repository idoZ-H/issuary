// Guards the eval indexer's ported chunker against drift from production.
// If src/lib/chunker.ts changes, this fails until eval/m3/chunker.mjs matches.
import { describe, it, expect } from "vitest";
import { LineWindowChunker } from "../../src/lib/chunker";
import { isExcludedFromCodeIndex } from "../../src/pipeline/code-index";
import { chunkFile, isExcluded } from "../../eval/m3/chunker.mjs";

const prod = new LineWindowChunker();
const samples = [
  ["src/a.js", Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")],
  ["src/short.js", "one\ntwo\nthree"],
  ["src/exact.js", Array.from({ length: 60 }, (_, i) => `L${i}`).join("\n")],
  ["src/blank.js", "   \n\n  "],
  ["src/empty.js", ""],
];

describe("eval/m3 chunker parity with production LineWindowChunker", () => {
  for (const [path, content] of samples) {
    it(`matches production chunks for ${path}`, () => {
      expect(chunkFile(content, path)).toEqual(prod.chunk(content, path));
    });
  }
});

describe("isExcluded parity", () => {
  it("excludes docs/ and markdown, keeps code", () => {
    expect(isExcluded("docs/guide.txt")).toBe(true);
    expect(isExcluded("README.md")).toBe(true);
    expect(isExcluded("a/b/notes.mdx")).toBe(true);
    expect(isExcluded("src/services/whatsapp.js")).toBe(false);
  });

  // The eval indexer must drop exactly what production drops, or the A/B is run
  // against a different chunk set than ships. Cross-check both functions agree.
  const paths = [
    "docs/x.md", "README.md", "notes.mdx", "public/admin.html", "src/services/foo.js",
    "public/logo.png", "src/a.JPG", "icons/star.svg", "fonts/Inter.woff2", "scan.tif",
    "migration/data.xlsx", "report.doc", "deck.pptx", "declaration-template.pdf",
    "backup.tar.gz", "logs.tgz", "x.7z", "demo.mp4", "voice.mp3",
    "package-lock.json", "frontend/package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "npm-shrinkwrap.json", "src/config.json", "app/settings.yaml",
    "server.log", "logs/firebase-debug.log", "diff.txt", "changes.diff", "crash.dump",
    "src/dialog.js", "LICENSE.txt",
    "vendor.min.js", "styles.min.css", "dist/app.bundle.js", "data/users.csv",
    "data/metrics.tsv", "src/app.js", "src/styles.css",
  ];
  for (const p of paths) {
    it(`agrees with isExcludedFromCodeIndex for ${p}`, () => {
      expect(isExcluded(p)).toBe(isExcludedFromCodeIndex(p));
    });
  }
});
