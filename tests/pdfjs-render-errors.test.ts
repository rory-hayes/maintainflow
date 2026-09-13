import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { patchPdfJsRenderErrors } from '../scripts/pdfjs-render-errors.js';

const require = createRequire(import.meta.url);
const installedPath = require.resolve('pdfjs-dist');
let source: string, directory: string, pdfjs: typeof import('pdfjs-dist');
let canvas: typeof import('@napi-rs/canvas');
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  source = await readFile(installedPath, 'utf8');
  directory = await mkdtemp(join(tmpdir(), 'folio-pdfjs-render-errors-'));
  // Execute the installed browser module with the same transform as Vite. Keep
  // the dependency untouched and point its fake worker at the installed worker.
  const transformedPath = join(directory, 'pdf.mjs');
  await writeFile(transformedPath, patchPdfJsRenderErrors(source));
  canvas = require('@napi-rs/canvas');
  for (const key of ['DOMMatrix', 'Path2D', 'ImageData'] as const) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: canvas[key] });
  }
  pdfjs = await import(pathToFileURL(transformedPath).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/build/pdf.worker.mjs')).href;
});

after(async () => {
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(oversized: boolean) {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([200, 200]);
  page.drawRectangle({ x: 20, y: 20, width: 60, height: 60, color: rgb(0, 0, 0) });
  const image = await document.embedPng(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#333333' } }).png().toBuffer());
  await document.flush();
  if (oversized) {
    const stream = document.context.lookup(image.ref);
    assert.ok(stream instanceof PDFRawStream);
    stream.dict.set(PDFName.of('Width'), PDFNumber.of(50_000));
    stream.dict.set(PDFName.of('Height'), PDFNumber.of(50_000));
  }
  page.drawImage(image, { x: 100, y: 100, width: 50, height: 50 });
  return document.save();
}

async function open(oversized: boolean) {
  // The transformed module lives in a temporary directory, so supply the
  // installed canvas implementation through PDF.js's supported factory option.
  class CanvasFactory {
    create(width: number, height: number) {
      const target = canvas.createCanvas(width, height);
      return { canvas: target, context: target.getContext('2d') };
    }
    reset(target: ReturnType<CanvasFactory['create']>, width: number, height: number) {
      target.canvas.width = width; target.canvas.height = height;
    }
    destroy(target: ReturnType<CanvasFactory['create']>) {
      target.canvas.width = 0; target.canvas.height = 0;
    }
  }
  const task = pdfjs.getDocument({ data: await fixture(oversized), CanvasFactory, stopAtErrors: true, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 16_000_000 });
  const document = await task.promise;
  return { task, page: await document.getPage(1) };
}

function render(page: import('pdfjs-dist').PDFPageProxy) {
  const target = canvas.createCanvas(200, 200);
  const task = page.render({ canvas: null, canvasContext: target.getContext('2d') as unknown as CanvasRenderingContext2D, viewport: page.getViewport({ scale: 1 }) });
  return { target, task };
}

test('PDF.js preview transform refuses an unreviewed dependency version or changed error branch', () => {
  assert.throws(() => patchPdfJsRenderErrors(source.replaceAll('6.3.289', '6.3.290')));
  assert.throws(() => patchPdfJsRenderErrors(source.replace('} else if (intentState.opListReadCapability)', '} else if (intentState.opListReadCapability /* changed upstream */)')));
});

test('real oversized-image operator lists reject, including concurrent callers and a same-page retry', async () => {
  const { task, page } = await open(true);
  try {
    const first = page.getOperatorList(), concurrent = page.getOperatorList();
    await Promise.all([assert.rejects(first, /Image exceeded maximum allowed size/), assert.rejects(concurrent, /Image exceeded maximum allowed size/)]);
    await assert.rejects(page.getOperatorList(), /Image exceeded maximum allowed size/);
  } finally { await task.destroy(); }
});

test('real oversized-image renders all reject with the worker reason and never become successful on retry', async () => {
  const { task, page } = await open(true);
  try {
    const first = render(page), concurrent = render(page);
    await Promise.all([assert.rejects(first.task.promise, /Image exceeded maximum allowed size/), assert.rejects(concurrent.task.promise, /Image exceeded maximum allowed size/)]);
    await assert.rejects(render(page).task.promise, /Image exceeded maximum allowed size/);
  } finally { await task.destroy(); }
});

test('valid PDF operator lists and completed raster rendering remain usable after the transform', async () => {
  const { task, page } = await open(false);
  try {
    const operators = await page.getOperatorList();
    assert.ok(operators.fnArray.length > 0);
    const result = render(page);
    await result.task.promise;
    const pixel = result.target.getContext('2d').getImageData(40, 140, 1, 1).data;
    assert.deepEqual(Array.from(pixel), [0, 0, 0, 255]);
    const imagePixel = result.target.getContext('2d').getImageData(120, 80, 1, 1).data;
    assert.deepEqual(Array.from(imagePixel), [51, 51, 51, 255]);
    await render(page).task.promise;
  } finally { await task.destroy(); }
});
