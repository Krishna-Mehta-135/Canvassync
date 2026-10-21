const MAX_PAGES = 300;
const MAX_CHARS = 250_000;

/** Extract plain text from a PDF in the browser (pdf.js loaded on demand). */
export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  // No script evaluation from the PDF; cap pages and output so a hostile file stays cheap.
  const doc = await pdfjs.getDocument({
    data: await file.arrayBuffer(),
    isEvalSupported: false,
  }).promise;
  const pages: string[] = [];
  let chars = 0;
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES) && chars < MAX_CHARS; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    chars += pageText.length;
    pages.push(pageText);
  }
  return pages.filter(Boolean).join("\n\n");
}
