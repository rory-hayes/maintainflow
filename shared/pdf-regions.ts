import {z} from 'zod';
import {maximumExportFieldPathLength} from './export-contract.js';

export const pdfGeometryVersion='folio-native-pdf-geometry-v1' as const;
export const pdfRegionLimits=Object.freeze({maxBytes:10*1024*1024,maxPages:30,maxItemsPerPage:5000,maxItems:20000,maxTextBytes:1024*1024,maxItemText:4096,maxOutputBytes:8*1024*1024,maxPageDimension:14400,maxAnchor:200,coordinateTolerance:1e-6,referenceTolerance:0.01});
export interface PdfRegionRect{x:number;y:number;width:number;height:number;}
export interface PdfRegionRule{field:string;anchor:string;page:number;reference:{width:number;height:number;rotation:number};offset:PdfRegionRect;}
export interface PdfGeometryItem{id:number;text:string;rect:PdfRegionRect;separator:''|' '|'\n';}
export interface PdfPageGeometry{page:number;width:number;height:number;rotation:number;items:PdfGeometryItem[];reason:null|'no_native_text'|'unsupported_text_geometry';}
export interface PdfGeometry{version:typeof pdfGeometryVersion;sourceSha256:string;pageCount:number;pages:PdfPageGeometry[];}
export interface PdfRegionAnchor{text:string;capturedText:string;rect:PdfRegionRect;itemIds:number[];}
export const pdfRegionReasonLabels={invalid_rule:'This region definition is invalid.',invalid_geometry:'The native PDF geometry could not be verified.',missing_page:'The configured source page is missing.',page_geometry_changed:'The source page size or rotation differs from this template.',no_native_text:'This page has no supported native text. OCR is not used.',unsupported_text_geometry:'This page has unsupported native text geometry.',missing_anchor:'The exact anchor was not found on this page.',ambiguous_anchor:'The anchor appears more than once on this page.',region_outside_page:'The translated region falls outside this page.',partial_item:'The region cuts through a native text block. Include the complete block.',missing_value:'The region contains no complete native text blocks.',match_limit:'This region check exceeds the supported limits.'} as const;
export type PdfRegionReason=keyof typeof pdfRegionReasonLabels;
export type PdfRegionFailure={matched:false;reason:PdfRegionReason};
export type PdfRegionAnchorMatch={matched:true;anchor:PdfRegionAnchor}|PdfRegionFailure;
export type PdfRegionMatch={matched:true;version:typeof pdfGeometryVersion;page:number;text:string;rect:PdfRegionRect;anchor:PdfRegionAnchor;itemIds:number[]}|PdfRegionFailure;

/** Text stays literal and case-sensitive; only whitespace has shared normalization. */
export function normalizePdfRegionText(value:string){return value.replace(/\s+/gu,' ').trim();}
function validText(value:string){
 if(value.includes('\0'))return false;
 for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(n>=0xdc00&&n<=0xdfff)return false;}
 return true;
}
const dimension=z.number().finite().positive().max(pdfRegionLimits.maxPageDimension);
const rotation=z.union([z.literal(0),z.literal(90),z.literal(180),z.literal(270)]);
const fraction=z.number().finite().min(0).max(1),positiveFraction=z.number().finite().positive().max(1);
export const pdfRegionRectSchema=z.object({x:fraction,y:fraction,width:positiveFraction,height:positiveFraction}).strict().refine(r=>r.x+r.width<=1+pdfRegionLimits.coordinateTolerance&&r.y+r.height<=1+pdfRegionLimits.coordinateTolerance);
export const pdfRegionRuleSchema=z.object({field:z.string().min(1).max(maximumExportFieldPathLength).refine(validText),anchor:z.string().min(1).max(pdfRegionLimits.maxAnchor).refine(validText).transform(normalizePdfRegionText).refine(Boolean),page:z.number().int().min(1).max(pdfRegionLimits.maxPages),reference:z.object({width:dimension,height:dimension,rotation}).strict(),offset:z.object({x:z.number().finite().min(-1).max(1),y:z.number().finite().min(-1).max(1),width:positiveFraction,height:positiveFraction}).strict()}).strict();
const itemSchema=z.object({id:z.number().int().min(1).max(pdfRegionLimits.maxItemsPerPage),text:z.string().min(1).max(pdfRegionLimits.maxItemText).refine(validText),rect:pdfRegionRectSchema,separator:z.enum(['',' ','\n'])}).strict();
export const pdfPageGeometrySchema=z.object({page:z.number().int().min(1).max(pdfRegionLimits.maxPages),width:dimension,height:dimension,rotation,items:z.array(itemSchema).max(pdfRegionLimits.maxItemsPerPage),reason:z.enum(['no_native_text','unsupported_text_geometry']).nullable()}).strict().refine(page=>{
 if(page.reason!==null)return page.items.length===0;
 return page.items.length>0&&page.items.every((item,index)=>normalizePdfRegionText(item.text)!==''&&(index===0||item.id>page.items[index-1].id));
});
export const pdfGeometrySchema=z.object({version:z.literal(pdfGeometryVersion),sourceSha256:z.string().regex(/^[0-9a-f]{64}$/),pageCount:z.number().int().min(1).max(pdfRegionLimits.maxPages),pages:z.array(pdfPageGeometrySchema).min(1).max(pdfRegionLimits.maxPages)}).strict().refine(geometry=>{
 if(geometry.pageCount!==geometry.pages.length||geometry.pages.some((page,index)=>page.page!==index+1))return false;
 let items=0,bytes=0;const encoder=new TextEncoder();
 for(const page of geometry.pages)for(const item of page.items){items++;bytes+=encoder.encode(item.text).length;}
 return items<=pdfRegionLimits.maxItems&&bytes<=pdfRegionLimits.maxTextBytes;
});
export function canonicalPdfRegionRule(value:unknown):string{return JSON.stringify(pdfRegionRuleSchema.parse(value));}

export const pdfGeometryErrorReasons={pdf_required:'Native regions require a PDF file.',geometry_limit:'The PDF exceeds the native region geometry limits.',geometry_invalid:'The native PDF geometry could not be read safely.'} as const;
export type PdfGeometryErrorReason=keyof typeof pdfGeometryErrorReasons;
export const isPdfGeometryErrorReason=(value:unknown):value is PdfGeometryErrorReason=>typeof value==='string'&&Object.hasOwn(pdfGeometryErrorReasons,value);
export class PdfGeometryError extends Error{
 readonly code='pdf_geometry_failed';readonly statusCode:number;
 constructor(readonly reason:PdfGeometryErrorReason){super(pdfGeometryErrorReasons[reason]);this.name='PdfGeometryError';this.statusCode=reason==='geometry_limit'?413:reason==='pdf_required'?400:422;}
}

const fail=(reason:PdfRegionReason):PdfRegionFailure=>({matched:false,reason});
function union(items:PdfGeometryItem[]):PdfRegionRect{
 const x=Math.min(...items.map(i=>i.rect.x)),y=Math.min(...items.map(i=>i.rect.y));
 return{x,y,width:Math.max(...items.map(i=>i.rect.x+i.rect.width))-x,height:Math.max(...items.map(i=>i.rect.y+i.rect.height))-y};
}
/** Preserve complete native block contents and their explicit reading-order joins. */
function capturedText(items:PdfGeometryItem[]){return items.map((item,index)=>(index?item.separator:'')+item.text).join('');}
function anchorOnPage(page:PdfPageGeometry,query:string):PdfRegionAnchorMatch{
 if(page.reason)return fail(page.reason);
 const anchor=normalizePdfRegionText(query);if(!anchor)return fail('invalid_rule');
 const segments:{start:number;end:number;item:PdfGeometryItem}[]=[];let stream='';
 for(const item of page.items){
  const text=normalizePdfRegionText(item.text);
  const previous=segments.at(-1)?.item;
  if(previous&&(item.separator!==''||/\s$/u.test(previous.text)||/^\s/u.test(item.text)))stream+=' ';
  const start=stream.length;stream+=text;segments.push({start,end:stream.length,item});
 }
 const start=stream.indexOf(anchor);if(start<0)return fail('missing_anchor');
 // Overlapping occurrences also make an anchor ambiguous, including one block.
 if(stream.indexOf(anchor,start+1)>=0)return fail('ambiguous_anchor');
 const end=start+anchor.length,items=segments.filter(segment=>segment.start<end&&segment.end>start).map(segment=>segment.item);
 if(!items.length)return fail('missing_anchor');
 return{matched:true,anchor:{text:anchor,capturedText:capturedText(items),rect:union(items),itemIds:items.map(item=>item.id)}};
}
export function findPdfRegionAnchor(page:PdfPageGeometry,anchor:string):PdfRegionAnchorMatch{
 if(typeof anchor!=='string'||anchor.length>pdfRegionLimits.maxAnchor||!validText(anchor))return fail('invalid_rule');
 const parsed=pdfPageGeometrySchema.safeParse(page);if(!parsed.success)return fail('invalid_geometry');
 if(new TextEncoder().encode(page.items.map(item=>item.text).join('')).length>pdfRegionLimits.maxTextBytes)return fail('match_limit');
 return anchorOnPage(parsed.data,anchor);
}
export function matchPdfRegion(geometry:PdfGeometry,value:PdfRegionRule):PdfRegionMatch{
 const rule=pdfRegionRuleSchema.safeParse(value);if(!rule.success)return fail('invalid_rule');
 if(geometry?.version!==pdfGeometryVersion||!Array.isArray(geometry.pages)||geometry.pageCount!==geometry.pages.length||geometry.pageCount>pdfRegionLimits.maxPages)return fail('invalid_geometry');
 const page=geometry.pages.find(item=>item.page===rule.data.page);if(!page)return fail('missing_page');
 const parsed=pdfPageGeometrySchema.safeParse(page);if(!parsed.success)return fail('invalid_geometry');
 const reference=rule.data.reference;
 if(page.rotation!==reference.rotation||Math.abs(page.width-reference.width)>pdfRegionLimits.referenceTolerance||Math.abs(page.height-reference.height)>pdfRegionLimits.referenceTolerance)return fail('page_geometry_changed');
 const found=findPdfRegionAnchor(parsed.data,rule.data.anchor);if(!found.matched)return found;
 const rect={x:found.anchor.rect.x+rule.data.offset.x,y:found.anchor.rect.y+rule.data.offset.y,width:rule.data.offset.width,height:rule.data.offset.height};
 const tolerance=pdfRegionLimits.coordinateTolerance;
 if(rect.x<0||rect.y<0||rect.x+rect.width>1+tolerance||rect.y+rect.height>1+tolerance)return fail('region_outside_page');
 const selected:PdfGeometryItem[]=[];
 for(const item of page.items){const r=item.rect;
  const intersects=Math.min(rect.x+rect.width,r.x+r.width)-Math.max(rect.x,r.x)>tolerance&&Math.min(rect.y+rect.height,r.y+r.height)-Math.max(rect.y,r.y)>tolerance;
  if(!intersects)continue;
  if(r.x<rect.x-tolerance||r.y<rect.y-tolerance||r.x+r.width>rect.x+rect.width+tolerance||r.y+r.height>rect.y+rect.height+tolerance)return fail('partial_item');
  selected.push(item);
 }
 if(!selected.length)return fail('missing_value');
 return{matched:true,version:pdfGeometryVersion,page:page.page,text:capturedText(selected),rect,anchor:found.anchor,itemIds:selected.map(item=>item.id)};
}
