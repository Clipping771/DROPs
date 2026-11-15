// Non-text files the agent can read: images (sent to the model as images) and PDFs (text extracted
// with Mozilla's pdf.js).
const fsp = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 50;

const imageType = (file) => IMAGE_TYPES[path.extname(file).toLowerCase()] || null;
const isPdf = (file) => path.extname(file).toLowerCase() === '.pdf';

async function readImage(abs) {
  const media_type = imageType(abs);
  const buf = await fsp.readFile(abs);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image is ${(buf.length / 1048576).toFixed(1)} MB; the limit is 5 MB.`);
  return { type: 'image', source: { type: 'base64', media_type, data: buf.toString('base64') }, bytes: buf.length };
}

// "3", "1-5", "2,4,7-9" → sorted unique page numbers within 1..total.
function parsePages(spec, total) {
  if (!spec) return Array.from({ length: Math.min(total, 20) }, (_, i) => i + 1);
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Invalid pages "${spec}". Use forms like "3", "1-5" or "2,4,7-9".`);
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let p = Math.min(a, b); p <= Math.max(a, b) && set.size <= MAX_PDF_PAGES; p++) if (p >= 1 && p <= total) set.add(p);
  }
  const pages = [...set].sort((x, y) => x - y);
  if (pages.length > MAX_PDF_PAGES) throw new Error(`At most ${MAX_PDF_PAGES} pages per read.`);
  if (!pages.length) throw new Error(`No such pages; the PDF has ${total} page${total === 1 ? '' : 's'}.`);
  return pages;
}

let pdfjsP = null;
function loadPdfjs() {
  if (!pdfjsP) {
    pdfjsP = (async () => {
      const base = path.dirname(require.resolve('pdfjs-dist/package.json'));
      const lib = await import(pathToFileURL(path.join(base, 'legacy', 'build', 'pdf.mjs')).href);
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(base, 'legacy', 'build', 'pdf.worker.mjs')).href;
      return lib;
    })();
    pdfjsP.catch(() => { pdfjsP = null; });
  }
  return pdfjsP;
}

async function readPdf(abs, pagesSpec) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await fsp.readFile(abs));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const total = doc.numPages;
    const pages = parsePages(pagesSpec, total);
    const out = [];
    let chars = 0;
    for (const p of pages) {
      const tc = await (await doc.getPage(p)).getTextContent();
      let text = '';
      for (const it of tc.items) { text += it.str; if (it.hasEOL) text += '\n'; else if (it.str && !/\s$/.test(it.str)) text += ' '; }
      text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      chars += text.length;
      out.push(`--- Page ${p} ---\n${text || '[no text on this page: it may be a scanned image]'}`);
    }
    const shown = pages.length === total ? `all ${total}` : `${pages.join(', ')} of ${total}`;
    let head = `[PDF ${path.basename(abs)}: pages ${shown}]`;
    if (!pagesSpec && total > pages.length) head += `\n[showing the first ${pages.length} pages; pass pages (e.g. "${pages.length + 1}-${Math.min(total, pages.length + 20)}") to read more]`;
    if (!chars) head += '\n[no extractable text: the PDF is probably scanned images]';
    return `${head}\n\n${out.join('\n\n')}`;
  } finally { await Promise.resolve(task.destroy?.()).catch(() => {}); }
}

module.exports = { IMAGE_TYPES, imageType, isPdf, readImage, readPdf, parsePages, MAX_IMAGE_BYTES };
