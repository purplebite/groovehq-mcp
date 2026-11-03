// Fetches one attachment from Groove. The download link itself grants access, so no token is sent,
// and only Groove's own download links are fetched: the tool must not become a proxy for any URL
export const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20000;

export interface Download {
  bytes: Uint8Array;
  fileName: string;
  declaredType?: string;
}

export function checkDownloadUrl(value: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.hostname !== 'files.groovehq.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/f\/download\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw new Error('Only a downloadUrl from listMessages can be read: https://files.groovehq.com/f/download/...');
  }
  return url;
}

function fileNameFrom(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const encoded = disposition.match(/filename\*\s*=\s*utf-8''([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Fall back to the plain name
    }
  }
  const plain = disposition.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined;
}

// Groove sends no content-length, so the limit is applied while reading
async function readBody(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error('Attachment is larger than 10 MB');
      }
      chunks.push(value);
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

// Error messages leave out the link, because the link itself grants access
export async function download(value: string): Promise<Download> {
  const url = checkDownloadUrl(value);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Groove redirected the download (${response.status}); only direct downloads are read`);
  }
  if (!response.ok) throw new Error(`Could not download the attachment: ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('Attachment is larger than 10 MB');
  }

  return {
    bytes: await readBody(response),
    // A file name ends up in the text, so it can't add lines of its own
    fileName: (fileNameFrom(response.headers.get('content-disposition')) ?? 'attachment').replace(/[\r\n|]+/g, ' '),
    declaredType: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || undefined,
  };
}
