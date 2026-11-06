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
const MAX_FILES = 25;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 30000;

// A URL comes from the model, so it must not reach anything on the local network.
// This reads the address itself; resolvedPrivately also checks where a name points
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal')) return true;
  if (host.includes(':')) {
    // Only global unicast addresses. 2002: wraps an IPv4 address, 2001:db8: is for documentation
    return !/^[23][0-9a-f]{0,3}:/.test(host) || host.startsWith('2002:') || host.startsWith('2001:db8:');
  }
  if (!host.includes('.')) return true;

  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

type Dns = typeof import('node:dns').promises;

// Loaded by a name the bundler can't follow, so a build without Node's modules, like a Worker
// without nodejs_compat, still works. There the name isn't checked, only the address
async function loadDns(): Promise<Dns | undefined> {
  const name = 'node:dns';
  try {
    const dns = await import(name);
    return dns.promises ?? dns.default?.promises;
  } catch {
    return undefined;
  }
}

async function addressesOf(dns: Dns, hostname: string, value: string): Promise<string[]> {
  try {
    return (await dns.lookup(hostname, { all: true })).map(entry => entry.address);
  } catch (error) {
    // Workers have no lookup, but they can ask DNS directly
    if (!/not implemented/i.test(error instanceof Error ? error.message : '')) {
      throw new Error(`Attachment URL can't be resolved: ${value}`);
    }
  }
  const results = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = results.flatMap(result => (result.status === 'fulfilled' ? result.value : []));
  if (!addresses.length) throw new Error(`Attachment URL can't be resolved: ${value}`);
  return addresses;
}

// Every address counts, because the download may use any of them. The name is looked up again
// for the download itself, so a name that changes in between (DNS rebinding) isn't caught
async function checkUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`Attachment URL must use https: ${value}`);
  if (isPrivateHost(url.hostname)) throw new Error(`Attachment URL is not allowed: ${value}`);

  const dns = await loadDns();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (dns && (await addressesOf(dns, hostname, value)).some(isPrivateHost)) {
    throw new Error(`Attachment URL is not allowed: ${value}`);
  }
  return url;
}

// The content-length header is optional, so the limit is applied while reading
async function readBody(response: Response, value: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error(`Attachment is larger than 20 MB: ${value}`);
      }
      chunks.push(chunk);
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function download(value: string): Promise<{ bytes: Uint8Array; contentType?: string }> {
  let url = await checkUrl(value);

  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Attachment URL redirected nowhere: ${value}`);
      url = await checkUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok) throw new Error(`Could not download ${value}: ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
      throw new Error(`Attachment is larger than 20 MB: ${value}`);
    }

    return {
      bytes: await readBody(response, value),
      contentType: response.headers.get('content-type')?.split(';')[0] || undefined,
    };
  }

  throw new Error(`Too many redirects: ${value}`);
}

function decodeBase64(value: string, fileName: string): Uint8Array {
  const base64 = value.replace(/\s/g, '');
  if ((base64.length * 3) / 4 - 2 > MAX_FILE_BYTES) throw new Error(`${fileName} is larger than 20 MB`);

  const binary = atob(base64);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function load(attachment: AttachmentArg) {
  if (Boolean(attachment.url) === Boolean(attachment.contentBase64)) {
    throw new Error(`Give ${attachment.fileName} either a url or contentBase64`);
  }

  if (attachment.url) return download(attachment.url);

  return { bytes: decodeBase64(attachment.contentBase64 as string, attachment.fileName), contentType: undefined };
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
