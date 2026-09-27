import {createHash} from 'node:crypto';
import type {Evidence,PageText} from '../../shared/types.js';
import {nativeDescriptionEvidenceVersion} from '../../shared/bank-evidence.js';

export const nativeDescriptionEvidenceLimits=Object.freeze({pages:30,pageText:512*1024,accounts:100,rows:20_000,description:4000,descriptionText:1024*1024,quotes:20,quoteText:2000,searchText:8*1024*1024,addedText:128*1024,candidates:64});
const limits=nativeDescriptionEvidenceLimits;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value:unknown,key:string)=>object(value)&&Object.hasOwn(value,key)?value[key]:undefined;
const collapsed=(value:string)=>value.replace(/\s+/g,' ').trim();

/** Whitespace-only matching, with offsets back to the untouched UTF-16 source. */
function indexed(page:PageText){
 const offsets=new Uint32Array(page.text.length),parts:string[]=[];let length=0;
 for(const match of page.text.matchAll(/\S+/g)){
  if(parts.length){offsets[length++]=match.index-1;parts.push(' ');}
  parts.push(match[0]);for(let i=0;i<match[0].length;i++)offsets[length++]=match.index+i;
 }
 return {...page,normalized:parts.join(''),offsets:offsets.subarray(0,length)};
}
function tokenBoundary(text:string,start:number,end:number){
 const word=/[\p{L}\p{N}\p{M}_]/u;
 const first=String.fromCodePoint(text.codePointAt(start)!),last=Array.from(text.slice(Math.max(start,end-2),end)).at(-1)!;
 const before=Array.from(text.slice(Math.max(0,start-2),start)).at(-1)||'',after=end<text.length?String.fromCodePoint(text.codePointAt(end)!):'';
 return !(word.test(first)&&word.test(before)||word.test(last)&&word.test(after));
}

/** Fresh bank PDF results only. Append exact source text; never replace provider
 * quotes, repair raw values, infer a transaction/column, or enrich saved runs. */
export function completeNativeBankDescriptionEvidence(rawValues:unknown,evidence:Record<string,Evidence[]>,pages:PageText[]):Record<string,Evidence[]>{
 if(!Array.isArray(pages)||!pages.length||pages.length>limits.pages)return evidence;
 let sourceLength=0;
 for(const [index,page] of pages.entries())if(!page||page.page!==index+1||typeof page.text!=='string'||(sourceLength+=page.text.length)>limits.pageText)return evidence;
 const accounts=own(rawValues,'accounts');if(!Array.isArray(accounts)||accounts.length>limits.accounts)return evidence;
 const descriptions:{field:string;value:string}[]=[],counts=new Map<string,number>();let rows=0,descriptionLength=0;
 for(const [accountIndex,account] of accounts.entries()){
  const transactions=own(account,'transactions');if(!Array.isArray(transactions)||(rows+=transactions.length)>limits.rows)return evidence;
  for(const [rowIndex,row] of transactions.entries()){
   const raw=own(row,'description');if(raw===null||raw===undefined||raw==='')continue;
   if(typeof raw!=='string'||raw.length>limits.description||(descriptionLength+=raw.length)>limits.descriptionText)return evidence;
   const value=collapsed(raw);if(!value)continue;
   descriptions.push({field:`accounts[${accountIndex}].transactions[${rowIndex}].description`,value});counts.set(value,(counts.get(value)||0)+1);
  }
 }
 const native=pages.map(indexed),searchLength=native.reduce((sum,page)=>sum+page.normalized.length,0);
 let result=evidence,searchWork=0,addedText=0;
 for(const {field,value} of descriptions){
  const quotes=Object.hasOwn(evidence,field)?evidence[field]:undefined;
  if(counts.get(value)!==1||value.length>limits.quoteText||!Array.isArray(quotes)||!quotes.length||quotes.length>=limits.quotes||!quotes.every(item=>item&&Number.isInteger(item.page)&&item.page>=1&&item.page<=pages.length&&typeof item.text==='string'&&item.text.length<=limits.quoteText))continue;
  const texts=quotes.map(item=>collapsed(item.text));
  if(texts.some(text=>text.includes(value))||quotes.every((item,index)=>index===0||item.page>=quotes[index-1].page)&&texts.join(' ').includes(value))continue;
  const anchors=quotes.filter((item,index)=>item.source==='matched-text'&&!item.derivation&&texts[index]&&value.includes(texts[index]));
  if(!anchors.length)continue;
  if((searchWork+=searchLength)>limits.searchText)break;
  let found:{page:ReturnType<typeof indexed>;start:number;end:number}|undefined,ambiguous=false;
  for(const page of native){
   let from=0,candidates=0,position:number;
   while((position=page.normalized.indexOf(value,from))!==-1){
    if(++candidates>limits.candidates){ambiguous=true;break;}
    from=position+1;if(!tokenBoundary(page.normalized,position,position+value.length))continue;
    if(found){ambiguous=true;break;}
    found={page,start:page.offsets[position],end:page.offsets[position+value.length-1]+1};
   }
   if(ambiguous)break;
  }
  if(!found||ambiguous||!anchors.some(item=>item.page===found!.page.page))continue;
  // A repeated short quote cannot identify which source row it referred to.
  // Require one uniquely occurring native anchor wholly inside the exact span.
  let anchored=false;
  for(const anchor of new Set(anchors.filter(item=>item.page===found!.page.page).map(item=>collapsed(item.text)))){
   if((searchWork+=found.page.normalized.length)>limits.searchText)return result;
   let position:number,from=0,anchorPosition=-1,anchorCount=0,candidates=0;
   while((position=found.page.normalized.indexOf(anchor,from))!==-1){
    if(++candidates>limits.candidates){anchorCount=2;break;}
    from=position+1;if(!tokenBoundary(found.page.normalized,position,position+anchor.length))continue;
    anchorPosition=position;if(++anchorCount>1)break;
   }
   if(anchorCount===1&&found.page.offsets[anchorPosition]>=found.start&&found.page.offsets[anchorPosition+anchor.length-1]+1<=found.end){anchored=true;break;}
  }
  if(!anchored)continue;
  const text=found.page.text.slice(found.start,found.end);
  if(text.length>limits.quoteText||addedText+text.length>limits.addedText)continue;
  // Guard the reconstructed source span independently before attaching provenance.
  if(collapsed(text)!==value)continue;
  const derived:Evidence={page:found.page.page,text,source:'matched-text',derivation:{version:nativeDescriptionEvidenceVersion,pageTextSha256:createHash('sha256').update(found.page.text,'utf8').digest('hex'),startUtf16:found.start,endUtf16:found.end}};
  if(result===evidence)result={...evidence};result[field]=[...quotes,derived];addedText+=text.length;
 }
 return result;
}
