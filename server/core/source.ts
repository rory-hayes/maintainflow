import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { z } from 'zod';
import {pdfGeometrySchema,pdfRegionLimits,PdfGeometryError,isPdfGeometryErrorReason,type PdfGeometryErrorReason,type PdfGeometry} from '../../shared/pdf-regions.js';
import { decoderLimits, decoderError } from './decoder-limits.js';
import { SourceValidationError, isSourceValidationReason, type SourceValidationReason } from './source-validation.js';
import type { PageText } from '../../shared/types.js';
import { canonicalPdfSplitSpec, planPdfSplit, verifyPdfMarkerRanges, pdfSplitLimits, PdfSplitValidationError, isPdfSplitValidationReason, type PdfSplitValidationReason, type PdfSplitSpec, type PdfPageRange } from '../../shared/pdf-split.js';
import {encodeSplitInput,encodeArchiveInput} from './decoder-input.js';
import {archiveImportLimits,archiveEntryReasons,canonicalArchiveImportSpec,ArchiveImportValidationError,isArchiveImportValidationReason,type ArchiveImportSpec,type ArchiveImportValidationReason} from '../../shared/archive-import.js';
import {sourceFormats} from '../../shared/source-formats.js';
import {tiffLimits,tiffRenderVersion,type TiffPageRenderMetadata,type TiffAiDocumentMetadata} from '../../shared/tiff.js';
import {inspectTiffStructure,isTiffHeader} from './tiff-engine.js';
import {scanZip,zipCrc32,isMacArchiveMetadataPath,isMacArchiveMetadata} from './zip-reader.js';
import {detectSourceFormat} from './decoder-engine.js';
import type {DecodedArchive} from './archive-engine.js';
export type {DecodedArchive,ArchiveSourcePart} from './archive-engine.js';
export { validateZipExpansion } from './decoder-engine.js';

const sourceSchema = z.object({
  mimeType: z.string().max(150),
  pages: z.array(z.object({ page: z.number().int().min(1).max(decoderLimits.maxPages), text: z.string() })).max(decoderLimits.maxPages),
  pageCount: z.number().int().min(1).max(decoderLimits.maxPages),
});
const failureSchema = z.union([
  z.object({ok:z.literal(false),code:z.literal('pdf_geometry_failed'),reason:z.custom<PdfGeometryErrorReason>(isPdfGeometryErrorReason)}).strict(),
  z.object({ ok: z.literal(false), code: z.literal('source_validation_failed'), reason: z.custom<SourceValidationReason>(isSourceValidationReason) }).strict(),
  z.object({ ok: z.literal(false), code: z.literal('pdf_split_validation_failed'), reason: z.custom<PdfSplitValidationReason>(isPdfSplitValidationReason) }).strict(),
  z.object({ok:z.literal(false),code:z.literal('archive_import_validation_failed'),reason:z.custom<ArchiveImportValidationReason>(isArchiveImportValidationReason)}).strict(),
  z.object({ ok: z.literal(false), code: z.literal('decoder_failed') }).strict(),
]);
const archiveFormatSchema=z.enum(sourceFormats.map(item=>item.id));
const archiveEntrySchema=z.object({
  index:z.number().int().min(1).max(archiveImportLimits.maxRecords),path:z.string().min(1).max(archiveImportLimits.maxPathBytes),
  byteSize:z.number().int().min(0).max(archiveImportLimits.maxBytes),sha256:z.string().regex(/^[0-9a-f]{64}$/),
  status:z.enum(['ready','unsupported','metadata']),format:archiveFormatSchema.nullable(),
  pageCount:z.number().int().min(1).max(archiveImportLimits.maxPagesPerDocument).nullable(),reason:z.enum(archiveEntryReasons).nullable(),
}).strict();
const archiveResponseSchema=z.object({ok:z.literal(true),archive:z.object({
  sourceSha256:z.string().regex(/^[0-9a-f]{64}$/),sourceByteSize:z.number().int().min(1).max(archiveImportLimits.maxBytes),
  entries:z.array(archiveEntrySchema).max(archiveImportLimits.maxRecords),
  parts:z.array(z.object({index:z.number().int().min(1).max(archiveImportLimits.maxRecords),path:z.string(),format:archiveFormatSchema,
    sha256:z.string().regex(/^[0-9a-f]{64}$/),data:z.string().min(1).max(4*Math.ceil(archiveImportLimits.maxBytes/3)),source:sourceSchema.strict(),
  }).strict()).max(archiveImportLimits.maxDocuments),totalPages:z.number().int().min(0).max(archiveImportLimits.maxDocuments*archiveImportLimits.maxPagesPerDocument),
}).strict()}).strict();
const responseSchema = z.union([z.object({ ok: z.literal(true), source: sourceSchema }).strict(), failureSchema]);
const splitResponseSchema = z.union([
  z.object({ ok: z.literal(true), split: z.object({
    sourcePageCount: z.number().int().min(1).max(pdfSplitLimits.maxPages),
    selectedPages: z.number().int().min(1).max(pdfSplitLimits.maxPages),
    parts: z.array(z.object({
      range: z.object({ start: z.number().int(), end: z.number().int() }).strict(),
      data: z.string().min(1).max(4 * Math.ceil(pdfSplitLimits.maxBytes / 3)),
      source: sourceSchema.extend({ mimeType: z.enum(['application/pdf','image/tiff']) }).strict(),
    }).strict()).min(1).max(pdfSplitLimits.maxDocuments),
  }).strict() }).strict(), failureSchema,
]);
const compiledChild = fileURLToPath(new URL('./decoder-child.js', import.meta.url));
const childFilename = existsSync(compiledChild) ? compiledChild : fileURLToPath(new URL('./decoder-child.ts', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
let activeDecoders = 0;

/** This subprocess is a resource boundary, not an OS-level security sandbox. */
export function decoderLaunchSpec(filename: string, split?: PdfSplitSpec, archive?:{spec?:ArchiveImportSpec},tiff?:{page?:number},geometry=false) {
  const sourceEntry = childFilename.endsWith('.ts');
  return {
    command: process.execPath,
    args: [`--max-old-space-size=${sourceEntry ? decoderLimits.sourceHeapMb : decoderLimits.heapMb}`, ...(sourceEntry ? ['--import', 'tsx'] : []), childFilename, geometry ? 'source.pdf' : tiff ? 'source.tiff' : archive ? 'archive.zip' : path.basename(filename), ...(geometry ? ['--pdf-geometry'] : split ? ['--pdf-split'] : archive ? ['--zip-import'] : tiff ? tiff.page===undefined?['--tiff-pdf']:['--tiff-page',String(tiff.page)]:[])],
    options: {
      cwd: runtimeRoot,
      env: { NODE_ENV: 'production', TZ: 'UTC', LANG: 'en_US.UTF-8', TSX_DISABLE_CACHE: '1' },
      stdio: 'pipe' as const,
    },
  };
}

type DecoderSpawn = (command: string, args: string[], options: ReturnType<typeof decoderLaunchSpec>['options']) => ChildProcessWithoutNullStreams;
export type DecoderOptions = { spawnChild?: DecoderSpawn; timeoutMs?: number;signal?:AbortSignal };
async function runIsolated<T>(
  bytes: Buffer,
  filename: string,
  decodeResponse: (value: unknown) => T,
  options: DecoderOptions,
  split?: PdfSplitSpec,
  archive?:{spec?:ArchiveImportSpec},
  tiff?:{page?:number},
  geometry=false,
): Promise<T> {
  options.signal?.throwIfAborted();
  if (!bytes.length) throw new SourceValidationError('empty');
  if (bytes.length > decoderLimits.maxBytes) throw new SourceValidationError('file_too_large');
  if (activeDecoders >= decoderLimits.concurrency) decoderError('Document decoding is busy. Retry shortly.', 429);
  activeDecoders++;
  try {
    return await new Promise((resolve, reject) => {
      const spec = decoderLaunchSpec(filename, split, archive,tiff,geometry);
      let child: ChildProcessWithoutNullStreams;
      try { child = (options.spawnChild || spawn)(spec.command, spec.args, spec.options); }
      catch { reject(Object.assign(new Error('The isolated document decoder could not start'), { statusCode: 503 })); return; }
      const chunks: Buffer[] = [];
      let outputBytes = 0, settled = false;
      let pendingFailure: Error | undefined;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort',abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const fail = (error: Error) => {
        if (settled || pendingFailure) return;
        pendingFailure = error;
        clearTimeout(timer);
        child.kill('SIGKILL');
      };
      const abort=()=>fail(Object.assign(new Error('Document decoding was cancelled'),{name:'AbortError'}));
      const timer = setTimeout(() => fail(Object.assign(new Error('Document decoding exceeded the 30-second time limit'), { statusCode: 422 })), options.timeoutMs || decoderLimits.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled || pendingFailure) return;
        outputBytes += chunk.length;
        if (outputBytes > (geometry ? pdfRegionLimits.maxOutputBytes : split ? pdfSplitLimits.maxOutputBytes : archive ? archiveImportLimits.maxOutputBytes : tiff&&tiff.page===undefined ? tiffLimits.maxOutputBytes:decoderLimits.maxOutputBytes)) {
          fail(Object.assign(new Error('Decoded source response exceeds the output limit'), { statusCode: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.on('error', () => fail(Object.assign(new Error('The isolated document decoder could not start'), { statusCode: 503 })));
      child.on('close', code => {
        if (settled) return;
        if (pendingFailure) { finish(pendingFailure); return; }
        if (code !== 0) { finish(Object.assign(new Error('The document decoder stopped within its resource limits'), { statusCode: 422 })); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result?.ok === false) {
            const failure = failureSchema.parse(result);
            if (failure.code === 'source_validation_failed') { finish(new SourceValidationError(failure.reason)); return; }
            if (geometry && failure.code === 'pdf_geometry_failed') {finish(new PdfGeometryError(failure.reason));return;}
            if (split && failure.code === 'pdf_split_validation_failed') { finish(new PdfSplitValidationError(failure.reason)); return; }
            if (archive && failure.code === 'archive_import_validation_failed') {finish(new ArchiveImportValidationError(failure.reason));return;}
            if (failure.code !== 'decoder_failed') throw new Error('Unexpected decoder failure');
            finish(Object.assign(new Error('The document could not be decoded. Retry shortly.'), { statusCode: 503 }));
            return;
          }
          finish(undefined, decodeResponse(result));
        } catch { finish(Object.assign(new Error('The document decoder returned an invalid response'), { statusCode: 422 })); }
      });
      child.stdin.on('error', () => {});
      options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted)abort();
      child.stdin.end(split ? encodeSplitInput(bytes, split) : archive ? encodeArchiveInput(bytes,archive.spec) : bytes);
    });
  } finally { activeDecoders--; }
}

/** Dependency injection is internal-only for resource-boundary regression tests. */
export function runDecoder(bytes: Buffer, filename: string, options: DecoderOptions = {}): Promise<{ mimeType: string; pages: PageText[]; pageCount: number }> {
  return runIsolated(bytes, filename, value => {
    const result = responseSchema.parse(value);
    if (!result.ok) throw new Error('Expected decoder source');
    if (result.source.pages.reduce((total, page) => total + Buffer.byteLength(page.text), 0) > decoderLimits.maxTextBytes) throw new Error('Decoder text limit exceeded');
    if(result.source.mimeType==='image/tiff'){const directory=inspectTiffStructure(bytes);if(result.source.pageCount!==directory.pages.length||result.source.pages.length!==directory.pages.length||result.source.pages.some((p,i)=>p.page!==i+1||p.text!==''))throw new Error('Invalid TIFF source page response');}
    return result.source;
  }, options);
}

export interface SplitPdfSource {
  sourcePageCount: number;
  selectedPages: number;
  parts: Array<{ range: PdfPageRange; bytes: Buffer; source: { mimeType: 'application/pdf' | 'image/tiff'; pageCount: number; pages: PageText[] } }>;
}

export function splitPdfSource(bytes: Buffer, filename: string, value: PdfSplitSpec, options: DecoderOptions = {}): Promise<SplitPdfSource> {
  // Validate/copy before spawning; caller mutation cannot change IPC interpretation.
  const spec: PdfSplitSpec = JSON.parse(canonicalPdfSplitSpec(value));
  const isTiff=isTiffHeader(bytes),mimeType=isTiff?'image/tiff':'application/pdf';
  if(isTiff&&spec.mode==='marker')throw new PdfSplitValidationError('tiff_marker_unsupported');
  const directory=isTiff?inspectTiffStructure(bytes):undefined;
  return runIsolated(bytes, filename, output => {
    const response = splitResponseSchema.parse(output);
    if (!response.ok) throw new Error('Expected PDF split');
    const result = response.split, plan = planPdfSplit(spec, result.sourcePageCount);
    if(directory&&directory.pages.length!==result.sourcePageCount)throw new Error('TIFF source count mismatch');
    if (result.selectedPages !== plan.selectedPages || result.parts.length !== plan.ranges.length) throw new Error('Split plan mismatch');
    let totalBytes = 0, totalText = 0;
    const parts = result.parts.map((part, index) => {
      const range = plan.ranges[index], count = range.end - range.start + 1;
      if (part.range.start !== range.start || part.range.end !== range.end || part.source.pageCount !== count || part.source.pages.length !== count) throw new Error('Split range mismatch');
      const childBytes = Buffer.from(part.data, 'base64');
      if (!childBytes.length || childBytes.length > pdfSplitLimits.maxBytes || childBytes.toString('base64') !== part.data || part.source.mimeType!==mimeType || (isTiff ? !isTiffHeader(childBytes) : !childBytes.subarray(0, 5).equals(Buffer.from('%PDF-')))) throw new Error('Split bytes invalid');
      if(isTiff){const child=inspectTiffStructure(childBytes);if(child.pages.length!==count||child.pages.some((p,i)=>{const original=directory!.pages[range.start-1+i];return p.width!==original.width||p.height!==original.height||p.orientation!==original.orientation;})||part.source.pages.some(p=>p.text!==''))throw new Error('TIFF split structure mismatch');}
      totalBytes += childBytes.length;
      for (const [i, page] of part.source.pages.entries()) {
        if (page.page !== i + 1) throw new Error('Split page numbering mismatch');
        totalText += Buffer.byteLength(page.text);
      }
      return { range, bytes: childBytes, source: part.source };
    });
    if (totalBytes > pdfSplitLimits.maxDerivedBytes || totalText > decoderLimits.maxTextBytes) throw new Error('Split response limit exceeded');
    verifyPdfMarkerRanges(spec, parts.flatMap(part => part.source.pages.map(page => page.text)));
    return { sourcePageCount: result.sourcePageCount, selectedPages: result.selectedPages, parts };
  }, options, spec);
}

export const inspectSource = (bytes: Buffer, filename: string, options:DecoderOptions={}) => runDecoder(bytes, filename,options);

function runArchive(bytes:Buffer,filename:string,spec:ArchiveImportSpec|undefined,options:DecoderOptions):Promise<DecodedArchive>{
  const sourceSha256=createHash('sha256').update(bytes).digest('hex');
  if(spec&&spec.sourceSha256!==sourceSha256)throw new ArchiveImportValidationError('source_mismatch');
  return runIsolated(bytes,filename,value=>{
    const {archive}=archiveResponseSchema.parse(value);
    if(archive.sourceSha256!==sourceSha256||archive.sourceByteSize!==bytes.length)throw new Error('Archive source mismatch');
    const records=scanZip(bytes).filter(record=>!record.directory);
    if(archive.entries.length!==records.length)throw new Error('Archive manifest mismatch');
    for(const [i,entry] of archive.entries.entries()){
      const record=records[i];
      if(entry.index!==record.index||entry.path!==record.path||entry.byteSize!==record.byteSize)throw new Error('Archive entry mismatch');
      if(entry.status==='ready'){
        if(entry.format===null||entry.pageCount===null||entry.reason!==null)throw new Error('Invalid ready entry');
      }else if(entry.format!==null||entry.pageCount!==null||!entry.reason||
        (entry.status==='metadata'&&!isMacArchiveMetadataPath(entry.path))||
        (entry.status==='metadata')!==(entry.reason===archiveEntryReasons.macos_metadata))throw new Error('Invalid excluded entry');
    }
    const ready=archive.entries.filter(entry=>entry.status==='ready');
    const selected=spec?spec.entries:ready.map(entry=>entry.index);
    if(archive.parts.length!==selected.length)throw new Error('Archive selection mismatch');
    let byteTotal=0,textTotal=0,totalPages=0;
    const parts=archive.parts.map((part,i)=>{
      const entry=archive.entries.find(entry=>entry.index===selected[i]);
      const record=records.find(record=>record.index===selected[i]);
      if(!entry||!record||entry.status!=='ready'||part.index!==entry.index||part.path!==entry.path||part.format!==entry.format||part.sha256!==entry.sha256||part.source.pageCount!==entry.pageCount||part.source.pages.length!==entry.pageCount||sourceFormats.find(format=>format.id===part.format)?.mimeType!==part.source.mimeType)throw new Error('Archive part mismatch');
      const childBytes=Buffer.from(part.data,'base64');
      if(childBytes.length!==entry.byteSize||childBytes.toString('base64')!==part.data||createHash('sha256').update(childBytes).digest('hex')!==part.sha256||zipCrc32(childBytes)!==record.crc32||detectSourceFormat(childBytes,entry.path)!==part.format||isMacArchiveMetadata(entry.path,childBytes))throw new Error('Archive bytes mismatch');
      if(part.format==='tiff'&&(inspectTiffStructure(childBytes).pages.length!==part.source.pageCount||part.source.pages.some(p=>p.text!=='')))throw new Error('Archive TIFF page mismatch');
      byteTotal+=childBytes.length;totalPages+=part.source.pageCount;
      for(const [index,page] of part.source.pages.entries()){
        if(page.page!==index+1)throw new Error('Archive page numbering mismatch');
        textTotal+=Buffer.byteLength(page.text);
      }
      const {data,...descriptor}=part;
      return {...descriptor,bytes:childBytes};
    });
    if(totalPages!==archive.totalPages||byteTotal>archiveImportLimits.maxExpandedBytes||textTotal>archiveImportLimits.maxTextBytes)throw new Error('Archive response exceeds limits');
    return {...archive,parts};
  },options,undefined,{spec});
}
export function previewArchiveSource(bytes:Buffer,filename:string,options:DecoderOptions={}):Promise<DecodedArchive>{return runArchive(bytes,filename,undefined,options);}
export function importArchiveSource(bytes:Buffer,filename:string,value:ArchiveImportSpec,options:DecoderOptions={}):Promise<DecodedArchive>{
  return runArchive(bytes,filename,JSON.parse(canonicalArchiveImportSpec(value)),options);
}


const tiffBaseSchema=z.object({pageCount:z.number().int().min(1).max(tiffLimits.maxPages),sourceSha256:z.string().regex(/^[0-9a-f]{64}$/),renderVersion:z.literal(tiffRenderVersion)});
const tiffPageSchema=z.object({ok:z.literal(true),tiff:tiffBaseSchema.extend({mimeType:z.literal('image/jpeg'),page:z.number().int().min(1).max(tiffLimits.maxPages),width:z.number().int().min(1).max(tiffLimits.maxEdge),height:z.number().int().min(1).max(tiffLimits.maxEdge),data:z.string().min(1).max(4*Math.ceil(tiffLimits.maxJpegBytes/3))}).strict()}).strict();
const tiffPdfSchema=z.object({ok:z.literal(true),tiff:tiffBaseSchema.extend({mimeType:z.literal('application/pdf'),data:z.string().min(1).max(4*Math.ceil(tiffLimits.maxPdfBytes/3))}).strict()}).strict();
export async function renderTiffPage(bytes:Buffer,page:number,options:DecoderOptions={}):Promise<TiffPageRenderMetadata&{bytes:Buffer}>{
 options.signal?.throwIfAborted();const structure=inspectTiffStructure(bytes);if(!Number.isInteger(page)||page<1||page>structure.pages.length)throw new SourceValidationError('tiff_page_bounds');
 const sourceSha256=createHash('sha256').update(bytes).digest('hex'),descriptor=structure.pages[page-1];
 return runIsolated(bytes,'source.tiff',value=>{
  const {data,...result}=tiffPageSchema.parse(value).tiff,output=Buffer.from(data,'base64');
  const swap=descriptor.orientation>=5,width=swap?descriptor.height:descriptor.width,height=swap?descriptor.width:descriptor.height,scale=Math.min(1,tiffLimits.maxEdge/Math.max(width,height));
  if(result.sourceSha256!==sourceSha256||result.page!==page||result.pageCount!==structure.pages.length||Math.abs(result.width-width*scale)>1||Math.abs(result.height-height*scale)>1||output.length>tiffLimits.maxJpegBytes||output.toString('base64')!==data||!output.subarray(0,3).equals(Buffer.from([255,216,255])))throw new Error('Invalid TIFF page response');
  return {...result,bytes:output};
 },options,undefined,undefined,{page});
}
export async function convertTiffForAI(bytes:Buffer,options:DecoderOptions={}):Promise<TiffAiDocumentMetadata&{bytes:Buffer}>{
 options.signal?.throwIfAborted();const structure=inspectTiffStructure(bytes),sourceSha256=createHash('sha256').update(bytes).digest('hex');
 return runIsolated(bytes,'source.tiff',value=>{
  const {data,...result}=tiffPdfSchema.parse(value).tiff,output=Buffer.from(data,'base64');
  if(result.sourceSha256!==sourceSha256||result.pageCount!==structure.pages.length||output.length>tiffLimits.maxPdfBytes||output.toString('base64')!==data||!output.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Invalid TIFF PDF response');
  return {...result,bytes:output};
 },options,undefined,undefined,{});
}

/** Geometry is opt-in and isolated; normal intake remains text-only. */
export async function readPdfGeometry(input:Buffer,options:DecoderOptions={}):Promise<PdfGeometry>{
 options.signal?.throwIfAborted();
 if(options.timeoutMs!==undefined&&(!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0||options.timeoutMs>decoderLimits.timeoutMs))throw new Error('Geometry deadline must be positive and at most 30 seconds');
 if(!input.length)throw new SourceValidationError('empty');
 if(input.length>pdfRegionLimits.maxBytes)throw new SourceValidationError('file_too_large');
 if(!input.subarray(0,5).equals(Buffer.from('%PDF-')))throw new PdfGeometryError('pdf_required');
 const bytes=Buffer.from(input),sourceSha256=createHash('sha256').update(bytes).digest('hex');
 return runIsolated(bytes,'source.pdf',value=>{
  const parsed=z.object({ok:z.literal(true),geometry:pdfGeometrySchema}).strict().parse(value).geometry;
  if(parsed.sourceSha256!==sourceSha256)throw new Error('Geometry source mismatch');
  return parsed;
 },options,undefined,undefined,undefined,true);
}
