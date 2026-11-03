// getAttachment: reads an attachment from listMessages and returns its content.
// Everything for it lives in this folder, so it can be removed in one go
import { ContentBlock, defineTool, mcpContent, READ_TOOL } from '../definition.js';
import { download } from './download.js';
import { isZip, readZip, ZIP_TYPES, zipKind } from './office.js';
import { pdfText } from './pdf.js';

const MAX_CHARS = 100000;
const IMAGE_MAX_BYTES = 3.5 * 1024 * 1024; // Claude takes images up to 5 MB, and base64 adds a third
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const TEXT_TYPES = ['application/json', 'image/svg+xml', 'message/rfc822'];

const EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  eml: 'message/rfc822',
};

// Groove says what a file is, but storage often answers application/octet-stream
function sniff(bytes: Uint8Array): string | undefined {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}

function typeOf(declared: string | undefined, bytes: Uint8Array, fileName: string): string {
  if (declared && declared !== 'application/octet-stream') return declared;
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;
  return sniff(bytes) ?? (extension && EXTENSIONS[extension]) ?? declared ?? 'application/octet-stream';
}

function truncate(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} chars]` : text;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export class AttachmentReader {
  async getAttachment(args: { downloadUrl: string }) {
    const { bytes, fileName, declaredType } = await download(args.downloadUrl);
    // Measured now: pdf.js takes over the buffer while it reads, which leaves it empty
    const size = bytes.length;
    let type = typeOf(declaredType, bytes, fileName);
    // Word, Excel, PowerPoint and plain zips are recognised by what's inside
    const kind = isZip(bytes) ? zipKind(bytes) : undefined;
    if (kind && ['application/octet-stream', 'application/zip', 'application/x-zip-compressed'].includes(type)) type = ZIP_TYPES[kind];
    const header = (extra?: string) => ['File: ' + fileName, 'Type: ' + type, extra, `Size: ${size} bytes`].filter(Boolean).join(' | ');
    const text = (extra: string | undefined, body: string) => mcpContent([{ type: 'text', text: `${header(extra)}\n\n${body}` }]);

    if (kind) {
      const read = readZip(bytes, kind);
      return text(read.detail, truncate(read.text));
    }

    if (type === 'application/pdf') {
      const pdf = await pdfText(bytes);
      return text(`Pages: ${pdf.pages}`, truncate(pdf.text));
    }

    if (IMAGE_TYPES.includes(type)) {
      if (size > IMAGE_MAX_BYTES) return text(undefined, 'Image is larger than 3.5 MB, which is too large to pass on as an image');
      const blocks: ContentBlock[] = [
        { type: 'text', text: header() },
        { type: 'image', data: toBase64(bytes), mimeType: type },
      ];
      return mcpContent(blocks);
    }

    if (type.startsWith('text/') || TEXT_TYPES.includes(type)) {
      return text(undefined, truncate(new TextDecoder().decode(bytes)));
    }

    return text(undefined, 'Content type not supported for reading');
  }
}

export const getAttachment = defineTool<{ downloadUrl: string }>({
  name: 'getAttachment',
  setting: 'readAttachments',
  annotations: READ_TOOL,
  description: 'Read the content of an attachment, up to 10 MB. Pass the downloadUrl that listMessages returns for it. PDF, Word, Excel and PowerPoint files come back as text, images as images, and a zip as a list of its files',
  inputSchema: {
    type: 'object',
    properties: {
      downloadUrl: {
        type: 'string',
        description: 'The downloadUrl of the attachment from listMessages (https://files.groovehq.com/f/download/...)',
      },
    },
    required: ['downloadUrl'],
  },
  handler: (args, { attachmentReader }) => attachmentReader.getAttachment(args),
});
