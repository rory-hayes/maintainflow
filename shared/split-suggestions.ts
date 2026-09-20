import type {PageText,VisualDocument} from './types';
import type {PdfPageRange,PdfSplitSpec} from './pdf-split';

export const splitSuggestionLimits=Object.freeze({perDay:10,pendingPerWorkspace:3,maxAttempts:3,maxGroups:20,maxPages:30,maxBytes:10*1024*1024,sourceRetentionHours:24});
export type SplitSuggestionMime='application/pdf'|'image/tiff';
export interface SplitSuggestionInput {bytes:Buffer;mimeType:SplitSuggestionMime;pages:PageText[];locale:string;signal?:AbortSignal;visualDocument?:VisualDocument;}
export interface SplitSuggestionResult {startPages:number[];model:string;promptVersion:string;tokenUsage:Record<string,unknown>;costUsd:number;}
export interface SplitSuggestionProvider {configured():boolean;suggest(input:SplitSuggestionInput):Promise<SplitSuggestionResult>;}
export type SplitSuggestionState='uploading'|'queued'|'processing'|'ready'|'failed'|'cancelled';
export interface SplitSuggestion {
 id:string;requestId:string;parserId:string;sourceDocumentId:string|null;sourceName:string;sourceSha256:string;sourceMimeType:SplitSuggestionMime;
 pageCount:number|null;state:SplitSuggestionState;attempts:number;maxAttempts:number;createdAt:string;updatedAt:string;expiresAt:string;
 startPages:number[]|null;ranges:PdfPageRange[]|null;error:string|null;model:string|null;promptVersion:string|null;tokenUsage:Record<string,unknown>;costUsd:number;
 acceptedSplitId:string|null;confirmedRequestId:string|null;confirmedOptions:PdfSplitSpec|null;creationClosed:boolean;
}
export interface SplitSuggestionProvenance {
 suggestionId:string;requestId:string;sourceSha256:string;sourcePageCount:number;model:string;promptVersion:string;
 startPages:number[];confirmedRanges:PdfPageRange[];tokenUsage:Record<string,unknown>;costUsd:number;
}

/** The model proposes starts only; ordered ranges cover the complete source. */
export function splitSuggestionRanges(startPages:unknown,pageCount:number):PdfPageRange[]{
 if(!Number.isInteger(pageCount)||pageCount<1||pageCount>splitSuggestionLimits.maxPages||!Array.isArray(startPages)||!startPages.length||startPages.length>splitSuggestionLimits.maxGroups||startPages[0]!==1
  ||startPages.some((page,index)=>!Number.isInteger(page)||page<1||page>pageCount||index>0&&page<=startPages[index-1]))throw new Error('The suggested page boundaries are invalid. Review the source and try again.');
 return startPages.map((start,index)=>({start,end:index+1<startPages.length?startPages[index+1]-1:pageCount}));
}
