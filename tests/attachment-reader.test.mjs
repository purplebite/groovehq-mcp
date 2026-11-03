import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createGrooveServer } from '../dist/server.js';
import { isMcpContent, mcpContent } from '../dist/tools/definition.js';

// getAttachment against a stand-in for files.groovehq.com. Nothing here uses the network
const GOOD = 'https://files.groovehq.com/f/download/abcDEF123_-xyz';
const MB = 1024 * 1024;

const realFetch = globalThis.fetch;
let fetched;
let reply;

beforeAll(() => {
  globalThis.fetch = (target, init) => {
    fetched.push({ url: String(target), init });
    return Promise.resolve(reply());
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  fetched = [];
  reply = () => new Response('hello', { headers: { 'content-type': 'text/plain' } });
});

async function call(args, options = {}) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createGrooveServer({ token: 'test-token', apiUrl: 'http://127.0.0.1:1/graphql', ...options }).connect(serverSide);
  const client = new Client({ name: 'attachments-test', version: '1.0.0' });
  await client.connect(clientSide);
  const result = await client.callTool({ name: 'getAttachment', arguments: args });
  await client.close();
  return { isError: result.isError ?? false, content: result.content, text: result.content[0].text };
}

const file = (body, headers) => () => new Response(body, { headers });

// A small PDF with one page per entry; an empty entry is a page without text, like a scan
function makePdf(pageTexts) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pageTexts.forEach((text, i) => {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('getAttachment only reads Groove download links', () => {
  test.each([
    ['the attachment link', 'https://files.groovehq.com/f/attachment/abcDEF123'],
    ['http', 'http://files.groovehq.com/f/download/abc'],
    ['another host', 'https://example.com/f/download/abc'],
    ['a look-alike host', 'https://files.groovehq.com.evil.com/f/download/abc'],
    ['a subdomain', 'https://example.files.groovehq.com/f/download/abc'],
    ['the host in the path', 'https://evil.com/files.groovehq.com/f/download/abc'],
    ['a user name', 'https://files.groovehq.com@evil.com/f/download/abc'],
    ['a user name on the right host', 'https://user@files.groovehq.com/f/download/abc'],
    ['a port', 'https://files.groovehq.com:8443/f/download/abc'],
    ['a query', `${GOOD}?x=1`],
    ['a fragment', `${GOOD}#x`],
    ['a path that walks out', 'https://files.groovehq.com/f/download/../attachment/abc'],
    ['an encoded path', 'https://files.groovehq.com/f/download/%2e%2e%2fattachment'],
    ['a deeper path', `${GOOD}/more`],
    ['no key', 'https://files.groovehq.com/f/download/'],
    ['not a URL', 'files.groovehq.com/f/download/abc'],
  ])('refuses %s without fetching it', async (_, downloadUrl) => {
    const result = await call({ downloadUrl });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Only a downloadUrl from listMessages can be read');
    expect(fetched).toEqual([]);
  });

  test('fetches a good link once, without redirects and without the token', async () => {
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(false);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe(GOOD);
    expect(fetched[0].init.redirect).toBe('manual');
    expect(fetched[0].init.headers).toBeUndefined();
    expect(JSON.stringify(fetched[0].init)).not.toContain('test-token');
  });

  test('does not follow a redirect', async () => {
    reply = () => new Response(null, { status: 302, headers: { location: 'https://example.com/x' } });
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('redirected');
    expect(fetched).toHaveLength(1);
  });

  test('an error leaves the link out', async () => {
    reply = () => new Response('gone', { status: 404 });
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('404');
    expect(result.text).not.toContain('abcDEF123');
  });
});

describe('size limit', () => {
  test('a content-length over 10 MB is refused before the body is read', async () => {
    let pulled = 0;
    reply = () => new Response(new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
    }), { headers: { 'content-length': String(11 * MB) } });
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('larger than 10 MB');
    expect(pulled).toBeLessThan(3);
  });

  test('without a content-length, reading stops just past 10 MB', async () => {
    let sent = 0;
    reply = () => new Response(new ReadableStream({
      pull(controller) {
        sent++;
        if (sent > 100) controller.close();
        else controller.enqueue(new Uint8Array(MB));
      },
    }));
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('larger than 10 MB');
    expect(sent).toBeLessThan(15);
  });
});

describe('PDF', () => {
  test('comes back as text per page with a header', async () => {
    const pdf = makePdf(['Ticket 1001 open', 'Ticket 1002 closed']);
    const size = pdf.length;
    reply = file(pdf, {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="report.pdf"',
    });
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    const [header, ...rest] = result.text.split('\n');
    expect(header).toBe(`File: report.pdf | Type: application/pdf | Pages: 2 | Size: ${size} bytes`);
    const body = rest.join('\n');
    expect(body).toContain('--- Page 1 ---\nTicket 1001 open');
    expect(body).toContain('--- Page 2 ---\nTicket 1002 closed');
  });

  test('is recognised by its first bytes when Groove calls it octet-stream', async () => {
    reply = file(makePdf(['Hello']), { 'content-type': 'application/octet-stream' });
    const result = await call({ downloadUrl: GOOD });
    expect(result.text).toContain('Type: application/pdf');
    expect(result.text).toContain('Hello');
  });

  test('without text says it is probably a scan', async () => {
    reply = file(makePdf(['', '']), { 'content-type': 'application/pdf' });
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Pages: 2');
    expect(result.text).toContain('No text found in this PDF');
  });

  test('a broken PDF is an error', async () => {
    reply = file('%PDF-1.4 not really', { 'content-type': 'application/pdf' });
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Could not read the PDF');
  });
});

describe('other types', () => {
  test('an image comes back as an image with a text block', async () => {
    reply = file(PNG, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="shot.png"' });
    const result = await call({ downloadUrl: GOOD });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: 'text', text: 'File: shot.png | Type: image/png | Size: 11 bytes' });
    expect(result.content[1]).toEqual({ type: 'image', data: Buffer.from(PNG).toString('base64'), mimeType: 'image/png' });
  });

  test('an image over 3.5 MB comes back as text only', async () => {
    const big = new Uint8Array(4 * MB);
    big.set(PNG);
    reply = file(big, { 'content-type': 'image/png' });
    const result = await call({ downloadUrl: GOOD });
    expect(result.content).toHaveLength(1);
    expect(result.text).toContain('larger than 3.5 MB');
  });

  test('an image type Claude does not take is not supported', async () => {
    reply = file(new Uint8Array(10), { 'content-type': 'image/heic' });
    const result = await call({ downloadUrl: GOOD });
    expect(result.content).toHaveLength(1);
    expect(result.text).toContain('Content type not supported for reading');
  });

  test.each([
    ['text/csv', 'a,b\n1,2'],
    ['application/json', '{"a":1}'],
    ['image/svg+xml', '<svg></svg>'],
  ])('%s comes back as text', async (type, body) => {
    reply = file(body, { 'content-type': `${type}; charset=utf-8` });
    const result = await call({ downloadUrl: GOOD });
    expect(result.text).toContain(`Type: ${type}`);
    expect(result.text.endsWith(body)).toBe(true);
  });

  test('long text is cut at 100,000 characters', async () => {
    reply = file('x'.repeat(150000), { 'content-type': 'text/plain' });
    const result = await call({ downloadUrl: GOOD });
    expect(result.text).toContain('[truncated at 100000 chars]');
    expect(result.text.split('\n\n')[1]).toHaveLength(100000);
  });

  test('anything else gives only its details', async () => {
    reply = file(new Uint8Array([0x50, 0x4b, 3, 4]), {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': "attachment; filename*=UTF-8''notitie%20v2.docx",
    });
    const result = await call({ downloadUrl: GOOD });
    expect(result.text).toBe(
      'File: notitie v2.docx | Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document | Size: 4 bytes\n\nContent type not supported for reading',
    );
  });

  test('a file name cannot add lines to the text', async () => {
    reply = file('hi', { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="a\\nFile: fake | b.txt"' });
    const result = await call({ downloadUrl: GOOD });
    expect(result.text.split('\n')[0].startsWith('File: a')).toBe(true);
    expect(result.text.match(/\|/g)).toHaveLength(2);
  });
});

describe('settings', () => {
  async function listed(options) {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createGrooveServer({ token: 'test-token', ...options }).connect(serverSide);
    const client = new Client({ name: 'attachments-test', version: '1.0.0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map(tool => tool.name).includes('getAttachment');
  }

  test('on by default, also with GROOVE_READ_ONLY', async () => {
    expect(await listed({})).toBe(true);
    expect(await listed({ readOnly: true })).toBe(true);
    expect((await call({ downloadUrl: GOOD }, { readOnly: true })).isError).toBe(false);
  });

  test('readAttachments false leaves it out and refuses a call without fetching', async () => {
    expect(await listed({ readAttachments: false })).toBe(false);
    const result = await call({ downloadUrl: GOOD }, { readAttachments: false, readOnly: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('getAttachment is disabled: reading attachments is turned off with GROOVE_READ_ATTACHMENTS=0');
    expect(fetched).toEqual([]);
  });
});

describe('own MCP content', () => {
  test('only a marked result counts', () => {
    expect(isMcpContent(mcpContent([{ type: 'text', text: 'x' }]))).toBe(true);
    expect(isMcpContent({ content: [{ type: 'text', text: 'x' }] })).toBe(false);
    expect(isMcpContent(JSON.parse(JSON.stringify(mcpContent([]))))).toBe(false);
    expect(isMcpContent(null)).toBe(false);
  });
});
