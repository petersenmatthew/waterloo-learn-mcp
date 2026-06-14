import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pdfToPng } from 'pdf-to-png-converter';
import { apiGetBinary, apiVersion, AuthError } from '../session.js';
import type { TopicFileResult } from './types.js';

const execFileAsync = promisify(execFile);

// Image tokens scale with pixel area, so the render targets a fixed output
// size instead of a fixed multiplier (intrinsic PDF page sizes vary wildly).
// ~800px on the long edge is about scale 1.0 for letter pages: ~650 tokens/page,
// still legible for handwritten lecture notes.
const TARGET_LONG_EDGE_PX = 800;
// 30 pages is about 20k tokens, fitting Claude Code's stock 25k MAX_MCP_OUTPUT_TOKENS
// with headroom - past the cap, the failure mode is the explicit continuation
// note below, not the client silently dropping trailing pages.
const MAX_PAGES = 30;

/** Parse "4", "1-5", or "2,4,7-9" into a sorted list of unique 1-based page numbers. */
function parsePages(spec: string): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`Invalid pages value "${spec}" - use forms like "4", "1-5", or "2,4,7-9".`);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (start < 1 || end < start) throw new Error(`Invalid page range "${part.trim()}" in "${spec}".`);
    for (let p = start; p <= end && pages.size <= MAX_PAGES; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Find a LibreOffice binary for PPTX->PDF conversion, or null if not installed. */
async function findSoffice(): Promise<string | null> {
  const candidates = [
    'soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
  ];
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 15_000 });
      return bin;
    } catch {
      // not found / not executable - try the next candidate
    }
  }
  return null;
}

async function pptxToPdf(pptx: Buffer, filename: string): Promise<Buffer> {
  const soffice = await findSoffice();
  if (!soffice) {
    throw new Error(
      'This topic is a PowerPoint file, and rendering it needs LibreOffice. ' +
        'Install it with `brew install --cask libreoffice` (macOS) and retry.',
    );
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-mcp-'));
  try {
    const inputPath = path.join(tmpDir, filename.replace(/[/\\]/g, '_') || 'slides.pptx');
    await fs.writeFile(inputPath, pptx);
    await execFileAsync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, inputPath], {
      timeout: 120_000,
    });
    const pdfPath = inputPath.replace(/\.[^.]+$/, '') + '.pdf';
    return await fs.readFile(pdfPath);
  } catch (err) {
    throw new Error(`LibreOffice failed to convert ${filename} to PDF: ${err instanceof Error ? err.message : err}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Download a topic's file and render it to one PNG per page/slide, so the
 * model can read both the text and the diagrams. PDFs render directly;
 * PPT/PPTX go through LibreOffice -> PDF first.
 */
export async function getTopicFile(
  courseId: number,
  topicId: string,
  pagesSpec?: string,
): Promise<TopicFileResult> {
  const le = await apiVersion('le');
  let file;
  try {
    file = await apiGetBinary(`/d2l/api/le/${le}/${courseId}/content/topics/${topicId}/file`);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // Some topic types 404 on the API route; the legacy direct-download route
    // covers them with the same session cookies.
    file = await apiGetBinary(`/d2l/le/content/${courseId}/topics/files/download/${topicId}/DirectFileTopicDownload`);
  }

  const filename = file.filename ?? 'file';
  const ext = path.extname(filename).toLowerCase();
  const isPdf =
    ext === '.pdf' ||
    file.contentType.includes('application/pdf') ||
    file.body.subarray(0, 4).toString() === '%PDF';
  const isPpt = ext === '.pptx' || ext === '.ppt' || file.contentType.includes('presentation');

  let pdf: Buffer;
  if (isPdf) {
    pdf = file.body;
  } else if (isPpt) {
    pdf = await pptxToPdf(file.body, filename);
  } else {
    throw new Error(
      `Topic file "${filename}" (${file.contentType || 'unknown type'}) is not a PDF or PowerPoint - ` +
        'only those can be rendered to images. Use get_content for its URL instead.',
    );
  }

  const meta = await pdfToPng(pdf, { returnMetadataOnly: true, viewportScale: 1 });
  const totalPages = meta.length;
  const longEdgePts = Math.max(meta[0]?.width ?? 0, meta[0]?.height ?? 0);
  const viewportScale = longEdgePts > 0 ? Math.min(2, TARGET_LONG_EDGE_PX / longEdgePts) : 1;

  let pagesToProcess = pagesSpec ? parsePages(pagesSpec) : Array.from({ length: totalPages }, (_, i) => i + 1);
  pagesToProcess = pagesToProcess.filter((p) => p <= totalPages);
  if (pagesToProcess.length === 0) {
    throw new Error(`No pages to render: "${pagesSpec}" is outside this document's range (1-${totalPages}).`);
  }
  let note: string | undefined;
  if (pagesToProcess.length > MAX_PAGES) {
    pagesToProcess = pagesToProcess.slice(0, MAX_PAGES);
    note =
      `Rendered the first ${MAX_PAGES} of ${totalPages} pages. ` +
      `Call again with pages="${pagesToProcess[MAX_PAGES - 1] + 1}-${totalPages}" for the rest.`;
  }
  const rendered = await pdfToPng(pdf, { viewportScale, pagesToProcess });
  return {
    filename,
    totalPages,
    pages: rendered
      .filter((p) => p.content)
      .map((p) => ({ page: p.pageNumber, png: p.content as Buffer })),
    note,
  };
}
