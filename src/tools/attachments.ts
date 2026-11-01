import { GrooveClient } from '../groove-client.js';
import { queries } from '../utils/graphql-queries.js';

export interface AttachmentArg {
  fileName: string;
  url?: string;
  contentBase64?: string;
  contentType?: string;
}

interface UploadRequest {
  key: string;
  request: {
    method: string;
    url: string;
    data: Array<{ name: string; value: string }>;
  };
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 25;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 30000;

// A URL comes from the model, so it must not reach anything on the local network
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal')) return true;
  if (host.includes(':')) {
    return host === '::1' || host === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith('::ffff:');
  }

  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function checkUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`Attachment URL must use https: ${value}`);
  if (isPrivateHost(url.hostname)) throw new Error(`Attachment URL is not allowed: ${value}`);
  return url;
}

async function download(value: string): Promise<{ bytes: Uint8Array; contentType?: string }> {
  let url = checkUrl(value);

  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Attachment URL redirected nowhere: ${value}`);
      url = checkUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) throw new Error(`Could not download ${value}: ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
      throw new Error(`Attachment is larger than 20 MB: ${value}`);
    }

    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type')?.split(';')[0] || undefined,
    };
  }

  throw new Error(`Too many redirects: ${value}`);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ''));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function load(attachment: AttachmentArg) {
  if (Boolean(attachment.url) === Boolean(attachment.contentBase64)) {
    throw new Error(`Give ${attachment.fileName} either a url or contentBase64`);
  }

  if (attachment.url) return download(attachment.url);

  const bytes = decodeBase64(attachment.contentBase64 as string);
  if (bytes.length > MAX_BASE64_BYTES) {
    throw new Error(`Base64 attachments are limited to 5 MB, use a url for ${attachment.fileName}`);
  }
  return { bytes, contentType: undefined };
}

async function upload(client: GrooveClient, attachment: AttachmentArg) {
  const { bytes, contentType: detected } = await load(attachment);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${attachment.fileName} is larger than 20 MB`);
  const contentType = attachment.contentType || detected || 'application/octet-stream';

  const { uploadPayloadGenerate: payload } = await client.request<{
    uploadPayloadGenerate: UploadRequest;
  }>(queries.uploadPayloadGenerate, { input: { fileName: attachment.fileName } });

  // The form already has a placeholder for the file itself
  const form = new FormData();
  for (const field of payload.request.data) {
    if (field.name !== 'file') form.append(field.name, field.value);
  }
  form.append('file', new Blob([bytes], { type: contentType }), attachment.fileName);

  const response = await fetch(payload.request.url, { method: payload.request.method, body: form });
  if (!response.ok) throw new Error(`Could not upload ${attachment.fileName}: ${response.status}`);

  return {
    key: payload.key,
    fileName: attachment.fileName,
    fileSize: String(bytes.length),
    contentType,
  };
}

// Uploads the files first, so a bad file stops the mail before anything is sent
export async function uploadAttachments(client: GrooveClient, attachments?: AttachmentArg[]) {
  if (!attachments?.length) return undefined;
  if (attachments.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} attachments per message`);

  const uploaded = [];
  for (const attachment of attachments) uploaded.push(await upload(client, attachment));
  return uploaded;
}
