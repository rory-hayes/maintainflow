import {canonicalPdfSplitSpec,planPdfSplit,pdfSplitLimits,PdfSplitValidationError,type PdfPageRange,type PdfSplitSpec} from '../../shared/pdf-split.js';
import {decodeTiffSource,inspectTiffGraph,type TiffField,type TiffIfd} from './tiff-engine.js';

const sizes:Record<number,number>={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,13:4,16:8,17:8,18:8};
const pointerKinds=new Map<number,Kind>([[330,'image'],[34665,'exif'],[34853,'gps'],[40965,'interop']]);
const blockCounts=new Map([[273,279],[324,325],[513,514]]);
type Kind='image'|'exif'|'gps'|'interop';
// These values are self-contained scalars, strings, rationals or byte arrays.
// Private tags, MakerNote, free-block maps, old JPEG table offsets and unknown
// pointer types are deliberately absent: copying them can retain stale offsets.
const imageTags=new Set([
 254,255,256,257,258,259,262,263,264,265,266,269,270,271,272,273,274,
 277,278,279,280,281,282,283,284,285,286,287,290,291,292,293,296,297,
 301,305,306,315,316,317,318,319,320,321,322,323,324,325,326,327,328,
 330,332,333,334,336,337,338,339,340,341,342,343,344,345,346,347,351,
 512,513,514,515,517,518,529,530,531,532,700,33432,33723,34377,34665,34675,34853,
]);
const exifTags=new Set([
 33434,33437,34850,34852,34855,34856,34864,34865,34866,34867,34868,34869,
 36864,36867,36868,36880,36881,36882,37121,37122,37377,37378,37379,37380,
 37381,37382,37383,37384,37385,37386,37396,37510,37520,37521,37522,
 37888,37889,37890,37891,37892,37893,40960,40961,40962,40963,40964,40965,
 41483,41484,41486,41487,41488,41492,41493,41495,41728,41729,41730,
 41985,41986,41987,41988,41989,41990,41991,41992,41993,41994,41995,41996,
 42016,42032,42033,42034,42035,42036,42037,42080,42081,42082,42240,
]);
const gpsTags=new Set(Array.from({length:32},(_,i)=>i));
const interopTags=new Set([1,2,4096,4097,4098]);
const tagsFor=(kind:Kind)=>kind==='image'?imageTags:kind==='exif'?exifTags:kind==='gps'?gpsTags:interopTags;
function unsupported():never{throw new PdfSplitValidationError('tiff_repack_unsupported');}

type Interval={start:number;end:number};
function intervalLookup(intervals:Interval[]){
 const sorted=intervals.slice().sort((a,b)=>a.start-b.start),maxEnds:number[]=[];
 for(let i=0;i<sorted.length;i++)maxEnds[i]=Math.max(sorted[i].end,maxEnds[i-1]??0);
 return(start:number,end:number)=>{
  let lo=0,hi=sorted.length;while(lo<hi){const mid=(lo+hi)>>>1;if(sorted[mid].start<end)lo=mid+1;else hi=mid;}
  return lo>0&&maxEnds[lo-1]>start;
 };
}

/** Builds fresh directories and copies only explicitly referenced selected data.
 * The TIFF byte order, encoded image blocks, metadata values, sample precision,
 * compression and per-page orientation are preserved without image transcoding.
 */
export async function decodeSplitTiffSource(bytes:Buffer,options:unknown){
 const spec:PdfSplitSpec=JSON.parse(canonicalPdfSplitSpec(options));
 if(spec.mode==='marker')throw new PdfSplitValidationError('tiff_marker_unsupported');
 const graph=inspectTiffGraph(bytes),{directory,nodes}=graph;
 const plan=planPdfSplit(spec,directory.pages.length),big=directory.bigTiff,le=directory.littleEndian;
 const header=big?16:8,countSize=big?8:2,entrySize=big?20:12,offsetSize=big?8:4,inlineSize=big?8:4,alignment=big?8:2;
 const uint=(offset:number,size:number)=>size===8?Number(le?bytes.readBigUInt64LE(offset):bytes.readBigUInt64BE(offset)):size===4?(le?bytes.readUInt32LE(offset):bytes.readUInt32BE(offset)):size===2?(le?bytes.readUInt16LE(offset):bytes.readUInt16BE(offset)):bytes[offset];
 const integers=(field:TiffField)=>Array.from({length:field.count},(_,i)=>uint(field.offset+i*sizes[field.type],sizes[field.type]));
 const mainOffsets=new Set(directory.pages.map(p=>p.ifdOffset)),imageIntervals:Interval[]=[],externalValues:Interval[]=[],ifdIntervals:Interval[]=[{start:0,end:header}];
 for(const node of nodes.values()){
  ifdIntervals.push({start:node.offset,end:node.offset+countSize+node.fields.size*entrySize+offsetSize});
  for(const field of node.fields.values())if(field.count*sizes[field.type]>inlineSize)externalValues.push({start:field.offset,end:field.offset+field.count*sizes[field.type]});
  for(const [tag,countTag]of blockCounts){const field=node.fields.get(tag),counts=node.fields.get(countTag);if(!node.image||!field||!counts)continue;const offsets=integers(field),lengths=integers(counts);for(let i=0;i<offsets.length;i++)imageIntervals.push({start:offsets[i],end:offsets[i]+lengths[i]});}
 }
 // Exact sharing is safe. Partial block overlap cannot prove that a selected
 // block excludes bytes belonging only to another page, so refuse to repack it.
 imageIntervals.sort((a,b)=>a.start-b.start||a.end-b.end);
 let previous:Interval|undefined;
 for(const interval of imageIntervals){if(previous&&interval.start<previous.end&&(interval.start!==previous.start||interval.end!==previous.end))unsupported();previous=interval;}
 const overlapsImage=intervalLookup(imageIntervals),overlapsDirectory=intervalLookup(ifdIntervals),overlapsValue=intervalLookup(externalValues);
 // Data blocks and directory values must be distinct, including excluded pages.
 for(const interval of imageIntervals)if(overlapsValue(interval.start,interval.end))unsupported();

 type OutputField={tag:number;type:number;count:number;value:TiffField;offset?:number;relocated?:number[]};
 type OutputNode={input:TiffIfd;kind:Kind;offset:number;fields:OutputField[];next:number};
 type Chunk={source:number;length:number;target:number};
 function planPart(range:PdfPageRange){
  const roots=directory.pages.slice(range.start-1,range.end).map(p=>p.ifdOffset),selected=new Map<number,Kind>();
  function include(offset:number,kind:Kind,auxiliary:boolean){
   if(auxiliary&&mainOffsets.has(offset))unsupported();
   const prior=selected.get(offset);if(prior){if(prior!==kind)unsupported();return;}
   const node=nodes.get(offset);if(!node)unsupported();selected.set(offset,kind);
   if(kind!=='image'&&node.image)unsupported();
   for(const [tag,field]of node.fields){
    if(!tagsFor(kind).has(tag))unsupported();
    const pointerKind=pointerKinds.get(tag);
    if((field.type===13||field.type===18)&&!pointerKind)unsupported();
    if(pointerKind){for(const child of integers(field))if(child)include(child,pointerKind,true);}
    else if(field.count*sizes[field.type]>inlineSize&&(overlapsDirectory(field.offset,field.offset+field.count*sizes[field.type])||overlapsImage(field.offset,field.offset+field.count*sizes[field.type])))unsupported();
   }
   if(auxiliary&&node.next)include(node.next,kind,true);
  }
  for(const offset of roots)include(offset,'image',false);
  // Deterministic layout: selected main directories first, then their auxiliary
  // graph. Fresh zeroed padding never copies arbitrary bytes from the original.
  const order=[...roots,...[...selected.keys()].filter(offset=>!roots.includes(offset))],output=new Map<number,OutputNode>(),chunks:Chunk[]=[],copied=new Map<string,number>();let length=header;
  function reserve(size:number){const offset=Math.ceil(length/alignment)*alignment;length=offset+size;if(!Number.isSafeInteger(length)||length>pdfSplitLimits.maxBytes)throw new PdfSplitValidationError('child_size_limit');return offset;}
  for(const offset of order){const input=nodes.get(offset)!;output.set(offset,{input,kind:selected.get(offset)!,offset:reserve(countSize+input.fields.size*entrySize+offsetSize),fields:[],next:0});}
  function copy(source:number,size:number){const key=`${source}/${size}`,prior=copied.get(key);if(prior!==undefined)return prior;const target=reserve(size);copied.set(key,target);chunks.push({source,length:size,target});return target;}
  for(const [offset,node]of output){
   const rootIndex=roots.indexOf(offset);node.next=rootIndex>=0?(output.get(roots[rootIndex+1])?.offset??0):(output.get(node.input.next)?.offset??0);
   for(const [tag,value]of node.input.fields){
    const field:OutputField={tag,type:value.type,count:value.count,value};
    if(pointerKinds.has(tag))field.relocated=integers(value).map(n=>n?output.get(n)!.offset:0);
    else if(blockCounts.has(tag)){
     const lengths=integers(node.input.fields.get(blockCounts.get(tag)!)!);
     field.relocated=integers(value).map((source,i)=>copy(source,lengths[i]));
     // TIFF permits SHORT strip offsets; relocated positions may exceed 65535.
     if(field.type===3)field.type=4;
    }
    const size=field.count*sizes[field.type];
    if(size>inlineSize)field.offset=field.relocated?reserve(size):copy(value.offset,size);
    node.fields.push(field);
   }
  }
  return {length,build(){
   const child=Buffer.alloc(length);
   function put(offset:number,value:number,size:number){if(size===8)le?child.writeBigUInt64LE(BigInt(value),offset):child.writeBigUInt64BE(BigInt(value),offset);else if(size===4)le?child.writeUInt32LE(value,offset):child.writeUInt32BE(value,offset);else if(size===2)le?child.writeUInt16LE(value,offset):child.writeUInt16BE(value,offset);else child[offset]=value;}
   child.write(le?'II':'MM',0,'ascii');put(2,big?43:42,2);if(big)put(4,8,2);put(big?8:4,output.get(roots[0])!.offset,offsetSize);
   for(const chunk of chunks)bytes.copy(child,chunk.target,chunk.source,chunk.source+chunk.length);
   for(const node of output.values()){
    put(node.offset,node.fields.length,countSize);
    for(const [i,field]of node.fields.entries()){
     const entry=node.offset+countSize+i*entrySize,valueOffset=entry+(big?12:8),size=field.count*sizes[field.type];
     put(entry,field.tag,2);put(entry+2,field.type,2);put(entry+4,field.count,big?8:4);
     if(field.offset!==undefined)put(valueOffset,field.offset,offsetSize);
     const target=field.offset??valueOffset;
     if(field.relocated)field.relocated.forEach((value,j)=>put(target+j*sizes[field.type],value,sizes[field.type]));
     else if(size<=inlineSize)bytes.copy(child,target,field.value.offset,field.value.offset+size);
    }
    put(node.offset+countSize+node.fields.length*entrySize,node.next,offsetSize);
   }
   return child;
  }};
 }
 const layouts=plan.ranges.map(planPart);
 if(layouts.reduce((sum,layout)=>sum+layout.length,0)>pdfSplitLimits.maxDerivedBytes)throw new PdfSplitValidationError('derived_size_limit');
 // Allocate all immutable child bytes before the first await. An internal caller
 // mutating its original buffer cannot change a later page during native decode.
 const children=layouts.map(layout=>layout.build()),parts=[];
 // Upload splitting retains the whole original, including omitted pages. It
 // must meet ordinary TIFF intake's complete native/AI-budget validation too.
 await decodeTiffSource(Buffer.from(bytes));
 for(const [index,child]of children.entries()){
  const range=plan.ranges[index],verified=inspectTiffGraph(child).directory,expected=directory.pages.slice(range.start-1,range.end);
  if(verified.pages.length!==expected.length||verified.pages.some((p,i)=>p.width!==expected[i].width||p.height!==expected[i].height||p.orientation!==expected[i].orientation))throw new Error('TIFF repack verification failed');
  // This fully decodes every page sequentially and applies the existing bounded
  // AI-document check. Corrupt native data/operational faults never produce parts.
  const source=await decodeTiffSource(child);
  parts.push({range,bytes:child,source});
 }
 return {sourcePageCount:directory.pages.length,selectedPages:plan.selectedPages,parts};
}
