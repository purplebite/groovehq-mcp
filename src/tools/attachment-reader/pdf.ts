// Text per page, via unpdf, which runs in Node and in Workers. Loaded only when a PDF is read
export async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  try {
    const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
    try {
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      if (text.every(page => !page.trim())) {
        return { pages: totalPages, text: "No text found in this PDF. It is probably a scan: its pages are images, which this tool can't read." };
      }
      return { pages: totalPages, text: text.map((page, index) => `--- Page ${index + 1} ---\n${page.trim()}`).join('\n\n') };
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch (error) {
    throw new Error(`Could not read the PDF: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
