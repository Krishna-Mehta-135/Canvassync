import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { extractPdfText } from "./extractPdfText";

/**
 * Text extraction for uploaded documents, done entirely in the browser so the
 * server never opens an untrusted archive: it only ever receives plain text.
 *
 * Office files (docx/xlsx/pptx) are zip archives, so they are the zip-bomb
 * surface. Entries are inflated as a stream with a hard byte budget and the
 * stream is aborted the moment it is exceeded, regardless of what the archive's
 * headers claim. Only the few XML parts we need are ever inflated.
 */

export const MAX_OFFICE_FILE_BYTES = 10 * 1024 * 1024; // compressed
export const MAX_PDF_FILE_BYTES = 15 * 1024 * 1024;
const MAX_PART_BYTES = 12 * 1024 * 1024; // inflated, per XML part
const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // inflated, whole archive
const MAX_ENTRIES = 5000;
const MAX_TEXT_CHARS = 200_000;
const MAX_SHEET_ROWS = 2000;

export const OFFICE_PATTERN = /\.(docx|xlsx|pptx)$/i;
export const isOfficeFile = (file: File) => OFFICE_PATTERN.test(file.name);

export class UnsafeArchiveError extends Error {}

/** Inflate only entries accepted by `wanted`, aborting on budget overrun. */
async function readZipParts(
  buffer: ArrayBuffer,
  wanted: (name: string) => boolean,
): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const parts = new Map<string, string>();
    const decoder = new TextDecoder("utf-8");
    let total = 0;
    let entries = 0;
    let pendingFiles = 0;
    let endReached = false;
    let failed = false;

    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    const maybeDone = () => {
      if (!failed && endReached && pendingFiles === 0) resolve(parts);
    };

    const unzip = new Unzip((file: UnzipFile) => {
      entries += 1;
      if (entries > MAX_ENTRIES) {
        fail(new UnsafeArchiveError("Archive has too many entries."));
        return;
      }
      if (!wanted(file.name)) return;
      // Declared size is only a cheap early reject; the byte counter below is the real guard.
      if (typeof file.originalSize === "number" && file.originalSize > MAX_PART_BYTES) {
        fail(new UnsafeArchiveError("A part of this file is too large to read safely."));
        return;
      }
      pendingFiles += 1;
      let partBytes = 0;
      const chunks: string[] = [];
      file.ondata = (err, chunk, final) => {
        if (failed) return;
        if (err) {
          fail(new UnsafeArchiveError("This file is corrupt."));
          return;
        }
        partBytes += chunk.length;
        total += chunk.length;
        if (partBytes > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) {
          file.terminate();
          fail(new UnsafeArchiveError("File expands too much to read safely."));
          return;
        }
        chunks.push(decoder.decode(chunk, { stream: !final }));
        if (final) {
          parts.set(file.name, chunks.join(""));
          pendingFiles -= 1;
          maybeDone();
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);

    try {
      // Feed in slices so a hostile entry can be cut off mid-inflate.
      const bytes = new Uint8Array(buffer);
      const SLICE = 256 * 1024;
      for (let i = 0; i < bytes.length && !failed; i += SLICE) {
        unzip.push(bytes.subarray(i, Math.min(i + SLICE, bytes.length)), i + SLICE >= bytes.length);
      }
      endReached = true;
      maybeDone();
    } catch {
      fail(new UnsafeArchiveError("This file is corrupt."));
    }
  });
}

function decodeEntities(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&amp;/g, "&");
}

/** Text of every <tag>…</tag> (non-greedy, no nesting) in order. */
function textRuns(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(decodeEntities(m[1] ?? ""));
  return out;
}

function docxText(xml: string) {
  return xml
    .split(/<\/w:p>/)
    .map((p) => textRuns(p, "w:t").join("").trim())
    .filter(Boolean)
    .join("\n");
}

function pptxText(slides: Array<[string, string]>) {
  return slides
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, xml], i) => {
      const text = xml
        .split(/<\/a:p>/)
        .map((p) => textRuns(p, "a:t").join("").trim())
        .filter(Boolean)
        .join("\n");
      return text ? `Slide ${i + 1}\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function columnIndex(ref: string) {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

function xlsxText(parts: Map<string, string>) {
  const shared = (parts.get("xl/sharedStrings.xml") ?? "")
    .split(/<\/si>/)
    .slice(0, -1)
    .map((si) => textRuns(si, "t").join(""));

  const sheetNames = textRuns(
    (parts.get("xl/workbook.xml") ?? "").replace(/<sheet\b([^>]*)\/>/g, "<s>$1</s>"),
    "s",
  ).map((attrs) => /name="([^"]*)"/.exec(attrs)?.[1] ?? "");

  const sheets = [...parts.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

  return sheets
    .map(([, xml], sheetIndex) => {
      const rows: string[] = [];
      const rowRe = /<row\b[^>]*>(.*?)<\/row>/gs;
      for (let r = rowRe.exec(xml); r && rows.length < MAX_SHEET_ROWS; r = rowRe.exec(xml)) {
        const cells: string[] = [];
        const cellRe = /<c\b([^>]*?)(?:\/>|>(.*?)<\/c>)/gs;
        for (let c = cellRe.exec(r[1] ?? ""); c; c = cellRe.exec(r[1] ?? "")) {
          const attrs = c[1] ?? "";
          const body = c[2] ?? "";
          const col = columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "A");
          const type = /\bt="(\w+)"/.exec(attrs)?.[1];
          const raw = /<v>([^<]*)<\/v>/.exec(body)?.[1];
          let value = "";
          if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? "";
          else if (type === "inlineStr") value = textRuns(body, "t").join("");
          else if (raw !== undefined) value = decodeEntities(raw);
          while (cells.length < col) cells.push("");
          cells[col] = value.replace(/\s+/g, " ").trim();
        }
        if (cells.some(Boolean)) rows.push(cells.join(" | "));
      }
      return rows.length ? `Sheet: ${sheetNames[sheetIndex] || sheetIndex + 1}\n${rows.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export async function extractDocumentText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  let text: string;

  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    if (file.size > MAX_PDF_FILE_BYTES) throw new UnsafeArchiveError("PDF is too large (max 15 MB).");
    text = await extractPdfText(file);
  } else if (OFFICE_PATTERN.test(name)) {
    if (file.size > MAX_OFFICE_FILE_BYTES) throw new UnsafeArchiveError("File is too large (max 10 MB).");
    const buffer = await file.arrayBuffer();
    if (name.endsWith(".docx")) {
      const parts = await readZipParts(buffer, (n) => n === "word/document.xml");
      text = docxText(parts.get("word/document.xml") ?? "");
    } else if (name.endsWith(".pptx")) {
      const parts = await readZipParts(buffer, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      text = pptxText([...parts.entries()]);
    } else {
      const parts = await readZipParts(
        buffer,
        (n) =>
          n === "xl/sharedStrings.xml" ||
          n === "xl/workbook.xml" ||
          /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
      );
      text = xlsxText(parts);
    }
  } else {
    text = await file.text();
  }
  return text.split("\0").join("").slice(0, MAX_TEXT_CHARS);
}
