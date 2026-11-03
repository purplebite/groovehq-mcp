// Word, Excel and PowerPoint files are zips of XML. fflate unzips them; the text is read with
// a few patterns, which is enough for text and cell values. Old .doc, .xls and .ppt files aren't zips
import { unzipSync } from 'fflate';

const MAX_UNZIPPED = 50 * 1024 * 1024;
const MAX_LISTED = 500;

export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// Only the named parts are unzipped. fflate makes each file exactly as large as the zip says,
// so adding up those sizes keeps a zip bomb from filling the memory
function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, string> {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: file => {
      if (!wanted(file.name)) return false;
      total += file.originalSize;
      if (total > MAX_UNZIPPED) throw new Error('This file unpacks to more than 50 MB, which is too large to read');
      return true;
    },
  });
  const decoder = new TextDecoder();
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, decoder.decode(data)]));
}

function entries(bytes: Uint8Array): Array<{ name: string; size: number }> {
  const found: Array<{ name: string; size: number }> = [];
  unzipSync(bytes, {
    filter: file => {
      found.push({ name: file.name, size: file.originalSize });
      return false;
    },
  });
  return found;
}

function decodeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

// The text runs of one paragraph: <w:t> in Word, <a:t> in PowerPoint
function runs(xml: string, prefix: 'w' | 'a'): string {
  const marked = xml
    .replace(new RegExp(`<${prefix}:tab\\b[^>]*/>`, 'g'), `<${prefix}:t>\t</${prefix}:t>`)
    .replace(new RegExp(`<${prefix}:br\\b[^>]*/>`, 'g'), `<${prefix}:t>\n</${prefix}:t>`);
  const pattern = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:t>`, 'g');
  return [...marked.matchAll(pattern)].map(match => decodeXml(match[1])).join('');
}

function paragraphs(xml: string, prefix: 'w' | 'a'): string[] {
  return [...xml.matchAll(new RegExp(`<${prefix}:p\\b[\\s\\S]*?</${prefix}:p>`, 'g'))].map(match => runs(match[0], prefix));
}

function docx(bytes: Uint8Array): string {
  const xml = unzip(bytes, name => name === 'word/document.xml')['word/document.xml'];
  if (xml === undefined) throw new Error('This Word file has no document part');
  // A table row becomes one line, with a tab between the cells
  const flat = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, row => {
    const cells = [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(cell => paragraphs(cell[0], 'w').join(' '));
    const escaped = cells.join('\t').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<w:p><w:r><w:t>${escaped}</w:t></w:r></w:p>`;
  });
  return paragraphs(flat, 'w').join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function pptx(bytes: Uint8Array): { slides: number; text: string } {
  const files = unzip(bytes, name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slides = Object.keys(files).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  const text = slides
    .map((name, index) => `--- Slide ${index + 1} ---\n${paragraphs(files[name], 'a').filter(line => line.trim()).join('\n')}`)
    .join('\n\n');
  return { slides: slides.length, text };
}

// Built-in number formats that show a date or time
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormat(code: string): boolean {
  // Leave out text in quotes, colours like [Red] and escaped characters before looking for d, m, y, h or s
  return /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
}

function excelDate(serial: number, from1904: boolean): string {
  const days = from1904 ? serial + 1462 : serial;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(days * 86400000));
  const iso = date.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function attribute(attributes: string, name: string): string | undefined {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/)?.[0] ?? 'A';
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function xlsx(bytes: Uint8Array): { sheets: number; text: string } {
  const files = unzip(
    bytes,
    name =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/styles.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(name),
  );
  const workbook = files['xl/workbook.xml'];
  if (workbook === undefined) throw new Error('This Excel file has no workbook part');

  const from1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  // Phonetic hints (rPh) aren't part of the text
  const shared = [...(files['xl/sharedStrings.xml'] ?? '').matchAll(/<si\b[\s\S]*?<\/si>/g)].map(item =>
    [...item[0].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join(''),
  );

  // Which cell styles show a date
  const styles = files['xl/styles.xml'] ?? '';
  const customFormats = new Map(
    [...styles.matchAll(/<numFmt\b([^>]*)\/?>/g)].map(match => [Number(attribute(match[1], 'numFmtId')), decodeXml(attribute(match[1], 'formatCode') ?? '')]),
  );
  const cellXfs = styles.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] ?? '';
  const dateStyles = [...cellXfs.matchAll(/<xf\b([^>]*)/g)].map(match => {
    const id = Number(attribute(match[1], 'numFmtId') ?? 0);
    return DATE_FORMATS.has(id) || (customFormats.has(id) && isDateFormat(customFormats.get(id) ?? ''));
  });

  const relations = new Map(
    [...(files['xl/_rels/workbook.xml.rels'] ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)].map(match => [
      attribute(match[1], 'Id'),
      attribute(match[1], 'Target') ?? '',
    ]),
  );
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map(match => {
    const target = relations.get(attribute(match[1], 'r:id')) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return { name: decodeXml(attribute(match[1], 'name') ?? ''), xml: files[path] ?? '' };
  });

  const text = sheets
    .map(sheet => {
      const rows = [...sheet.xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)].map(row => {
        const cells: string[] = [];
        for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const [, attributes, inner = ''] = cell;
          const type = attribute(attributes, 't');
          const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          let value = '';
          if (type === 's') value = shared[Number(raw)] ?? '';
          else if (type === 'inlineStr') value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join('');
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else if (raw !== undefined) {
            const style = Number(attribute(attributes, 's') ?? 0);
            value = (type === undefined || type === 'n') && dateStyles[style] ? excelDate(Number(raw), from1904) : decodeXml(raw);
          }
          cells[columnIndex(attribute(attributes, 'r') ?? '')] = value.replace(/[\t\n\r]+/g, ' ');
        }
        return Array.from(cells, cell => cell ?? '').join('\t').replace(/\t+$/, '');
      });
      return `--- Sheet: ${sheet.name} ---\n${rows.filter(row => row.trim()).join('\n')}`;
    })
    .join('\n\n');
  return { sheets: sheets.length, text };
}

function zipListing(bytes: Uint8Array): { files: number; text: string } {
  const files = entries(bytes).filter(entry => !entry.name.endsWith('/'));
  const shown = files.slice(0, MAX_LISTED).map(entry => `${entry.name} (${entry.size} bytes)`);
  if (files.length > MAX_LISTED) shown.push(`... and ${files.length - MAX_LISTED} more`);
  return { files: files.length, text: `Files in this zip (not read):\n${shown.join('\n')}` };
}

export type ZipKind = 'docx' | 'xlsx' | 'pptx' | 'zip';

export const ZIP_TYPES: Record<ZipKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

// Decided by what's inside, so a file Groove calls octet-stream, or a macro file like .xlsm, still works
export function zipKind(bytes: Uint8Array): ZipKind {
  let names: Set<string>;
  try {
    names = new Set(entries(bytes).map(entry => entry.name));
  } catch (error) {
    throw new Error(`Could not read the file: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (names.has('word/document.xml')) return 'docx';
  if (names.has('xl/workbook.xml')) return 'xlsx';
  if (names.has('ppt/presentation.xml')) return 'pptx';
  return 'zip';
}

export function readZip(bytes: Uint8Array, kind: ZipKind): { detail?: string; text: string } {
  try {
    if (kind === 'docx') return { text: docx(bytes) || 'No text found in this Word file' };
    if (kind === 'xlsx') {
      const sheet = xlsx(bytes);
      return { detail: `Sheets: ${sheet.sheets}`, text: sheet.text };
    }
    if (kind === 'pptx') {
      const deck = pptx(bytes);
      return { detail: `Slides: ${deck.slides}`, text: deck.text };
    }
    const listing = zipListing(bytes);
    return { detail: `Files: ${listing.files}`, text: listing.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(message.includes('too large') ? message : `Could not read the file: ${message}`);
  }
}
