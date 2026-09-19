import {useLayoutEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {useQueryClient} from '@tanstack/react-query';
import {ChevronLeft,ChevronRight,Scissors} from 'lucide-react';
import {Button,Field,Modal,Notice,Tabs} from '../../components/ui';
import {useSession} from '../../lib/session';
import {clearPendingPdfSplit,findPdfSplitReceipt,pdfSha256,readPendingPdfSplit,savePendingPdfSplit,saveMatchingPendingPdfSplit,uploadPdfSplit,type PendingPdfSplit} from '../../lib/pdf-split';
import {planPdfSplit,parsePdfRanges,pdfSplitLimits,findPdfMarkerRanges,type PdfSplitSpec,type PdfSplitReceipt} from '../../../shared/pdf-split';
import type {SourceFormat} from '../../../shared/source-formats';
import PdfCanvas from './PdfCanvas';

export type SplitParser={id:string;name:string;archived:boolean;fieldSetupState?:string;allowedFormats?:SourceFormat[]|null};
const pageRange=(start:number,end:number)=>start===end?String(start):`${start}–${end}`;
const describe=(options:PdfSplitSpec)=>options.mode==='every'?`Every ${options.pagesPerDocument} page${options.pagesPerDocument===1?'':'s'}`:`${options.mode==='marker'?`Text marker “${options.marker}” · `:''}${options.ranges.map(range=>pageRange(range.start,range.end)).join(', ')}`;

export default function SplitPdf({parser,disabled=false,onComplete}:{parser:SplitParser;disabled?:boolean;onComplete?:()=>void}){
  const session=useSession(),workspace=session.data?.workspace.id||'';
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false);const running=useRef(false);
  const pending=readPendingPdfSplit(workspace,parser.id);
  const eligible=!parser.archived&&parser.fieldSetupState==='ready'&&(parser.allowedFormats==null||parser.allowedFormats.includes('pdf'));
  if(!workspace||!session.data||session.data.workspace.role==='viewer')return null;
  const unavailable=parser.archived?'Restore this parser before starting a new split.':parser.fieldSetupState!=='ready'?'Finish parser field setup before splitting a PDF.':!eligible?'Enable PDF in accepted formats before splitting.':'';
  return <div className="pdf-split-entry"><Button type="button" variant="secondary" disabled={disabled||busy||!eligible&&!pending} onClick={()=>setOpen(true)}><Scissors/>{pending?'Resume PDF split':'Split a PDF'}</Button>{unavailable&&<p className="small muted">{unavailable} <Link className="link" to={`/app/parsers/${parser.id}?tab=${parser.fieldSetupState!=='ready'?'setup':'settings'}`}>Open parser {parser.fieldSetupState!=='ready'?'setup':'settings'}</Link></p>}<Modal title="Split a PDF" description={`Create separate documents in ${parser.name} from selected pages of one PDF.`} open={open} onOpenChange={value=>{if(!running.current)setOpen(value);}}><SplitPdfFlow key={`${session.data.user.id}:${workspace}:${parser.id}:${session.data.workspace.role}`} parser={parser} workspace={workspace} eligible={eligible} onBusy={value=>{running.current=value;setBusy(value);}} onClose={()=>setOpen(false)} onComplete={onComplete}/></Modal></div>;
}

function SplitPdfFlow({parser,workspace,eligible,onBusy,onClose,onComplete}:{parser:SplitParser;workspace:string;eligible:boolean;onBusy:(value:boolean)=>void;onClose:()=>void;onComplete?:()=>void}){
  const client=useQueryClient(),fileInput=useRef<HTMLInputElement>(null),running=useRef(false),selectionGeneration=useRef(0),mounted=useRef(true);
  const [pending,setPending]=useState<PendingPdfSplit|null>(()=>readPendingPdfSplit(workspace,parser.id));
  const [file,setFile]=useState<File|null>(null),[bytes,setBytes]=useState<Uint8Array|null>(null),[sha256,setSha256]=useState(''),[pageCount,setPageCount]=useState(0),[page,setPage]=useState(1);
  const [renderedPage,setRenderedPage]=useState<number|null>(null);
  const [mode,setMode]=useState<'every'|'ranges'|'marker'>('every'),[every,setEvery]=useState('1'),[ranges,setRanges]=useState(''),[marker,setMarker]=useState(''),[nativePages,setNativePages]=useState<string[]|null>(null),[textError,setTextError]=useState(''),[tab,setTab]=useState('Ranges');
  const [busy,setBusy]=useState(false),[reading,setReading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[receipt,setReceipt]=useState<PdfSplitReceipt|null>(null),[confirmNew,setConfirmNew]=useState(false);
  const previewGeneration=selectionGeneration.current;
  const markerMode=(pending?.options.mode||mode)==='marker';
  const activeMarker=pending?.options.mode==='marker'?pending.options.marker:marker;
  let options:PdfSplitSpec|undefined,plan:ReturnType<typeof planPdfSplit>|undefined,markerPlan:ReturnType<typeof findPdfMarkerRanges>|undefined,planError='';
  try{
    if(markerMode&&nativePages){
      if(!activeMarker.trim())throw new Error('Enter a text marker to find document boundaries.');
      markerPlan=findPdfMarkerRanges(activeMarker,nativePages);
      if(pending?.options.mode==='marker'&&JSON.stringify(markerPlan.ranges)!==JSON.stringify(pending.options.ranges))throw new Error('The detected boundaries do not match this saved request. Check its result before starting a new split.');
    }
    options=pending?.options||(mode==='every'?{mode:'every',pagesPerDocument:Number(every)}:mode==='ranges'?{mode:'ranges',ranges:parsePdfRanges(ranges)}:markerPlan?{mode:'marker',marker:markerPlan.marker,ranges:markerPlan.ranges}:undefined);
    if(pageCount&&options&&(!markerMode||markerPlan))plan=planPdfSplit(options,pageCount);
  }catch(cause){planError=cause instanceof Error?cause.message:'Check the selected page ranges.';}
  if(markerMode&&textError)planError=textError;
  const omitted:number[]=[];if(plan)for(let i=1;i<=pageCount;i++)if(!plan.ranges.some(range=>i>=range.start&&i<=range.end))omitted.push(i);
  const frozen=Boolean(pending),ready=Boolean(file&&sha256&&plan&&!planError&&!reading&&renderedPage===page);
  function adjustRanges(){if(markerPlan)setRanges(markerPlan.ranges.map(range=>range.start===range.end?String(range.start):`${range.start}-${range.end}`).join(', '));setMode('ranges');setTab('Ranges');}
  function markBusy(value:boolean){running.current=value;setBusy(value);onBusy(value);}
  function persist(value:PendingPdfSplit){savePendingPdfSplit(value);setPending(value);}
  function received(value:PdfSplitReceipt){if(!mounted.current)return;setReceipt(value);setNotice('');setError('');void client.invalidateQueries();onComplete?.();}
  async function check(value=pending){
    if(!value||running.current)return;const generation=selectionGeneration.current;markBusy(true);setError('');setNotice('Checking split result…');
    try{const result=await findPdfSplitReceipt(value);if(!mounted.current||generation!==selectionGeneration.current)return;if(result)received(result);else setNotice('No completed split receipt was found yet. Reselect the same PDF if needed, then retry this request.');}
    catch(cause){if(mounted.current&&generation===selectionGeneration.current){setNotice('');setError(cause instanceof Error?cause.message:'The split result could not be checked.');}}
    finally{if(mounted.current&&generation===selectionGeneration.current)markBusy(false);}
  }
  useLayoutEffect(()=>{mounted.current=true;if(pending)void check(pending);return()=>{mounted.current=false;selectionGeneration.current++;running.current=false;onBusy(false);};},[]);
  async function chooseFile(next:File|undefined){
    if(!next||running.current)return;const generation=++selectionGeneration.current;
    setError('');setNotice('');setFile(null);setBytes(null);setSha256('');setPageCount(0);setPage(1);setRenderedPage(null);setNativePages(null);setTextError('');setReading(true);
    try{
      if(next.size<1||next.size>pdfSplitLimits.maxBytes)throw new Error('Choose a PDF with data, up to 10 MB.');
      const contents=await next.arrayBuffer(),digest=await pdfSha256(contents);
      if(generation!==selectionGeneration.current)return;
      if(pending&&digest!==pending.sha256)throw new Error('This is a different file. Reselect the original PDF to retry this request, or explicitly start a new split.');
      setFile(next);setSha256(digest);setBytes(new Uint8Array(contents));
    }catch(cause){if(generation===selectionGeneration.current){setReading(false);setError(cause instanceof Error?cause.message:'The PDF could not be read.');}}
  }
  async function submit(){
    if(running.current||!ready||!file||!options||!eligible)return;
    markBusy(true);setError('');setNotice('Uploading and checking the PDF…');
    let request=pending;
    try{
      if(!request){const created:PendingPdfSplit={version:1,workspaceId:workspace,parserId:parser.id,requestId:crypto.randomUUID(),sha256,options};persist(created);request=created;}
      const result=await uploadPdfSplit(request,file,value=>{if(mounted.current)persist(value);else saveMatchingPendingPdfSplit(value);},()=>mounted.current);if(mounted.current)received(result);
    }catch(cause){
      if(!mounted.current)return;setNotice('');const message=cause instanceof Error?cause.message:'The split upload could not be confirmed.';
      if(request){try{const result=await findPdfSplitReceipt(request);if(result){received(result);return;}}catch{/* Preserve the original actionable error; the same request remains recoverable. */}}
      if(!mounted.current)return;setError(`${message}${request?' Your saved request is retained. Check its result before starting a new split.':' No upload was started.'}`);
    }finally{if(mounted.current)markBusy(false);}
  }
  function startNew(){
    try{clearPendingPdfSplit(workspace,parser.id);selectionGeneration.current++;setReading(false);setRenderedPage(null);setPending(null);setReceipt(null);setFile(null);setBytes(null);setSha256('');setPageCount(0);setPage(1);setMode('every');setEvery('1');setRanges('');setMarker('');setNativePages(null);setTextError('');setConfirmNew(false);setError('');setNotice('');if(fileInput.current)fileInput.current.value='';}
    catch{setError('The saved request could not be cleared. Enable browser session storage before starting another split.');}
  }
  return <div className="pdf-split-dialog" aria-busy={busy}>
    <Notice error={error} message={notice}/>
    {receipt?<section className="pdf-split-receipt" aria-label="PDF split result"><h3>{receipt.split.childCount} document{receipt.split.childCount===1?'':'s'} received · {receipt.split.selectedPages} page{receipt.split.selectedPages===1?'':'s'}</h3><p>{receipt.replayed?'This is the existing split result. Replaying it uses no additional page credits.':'The selected pages were received. Processing continues in the background.'} Review and approve each document before exporting.</p><ol>{receipt.documents.map(document=><li key={document.id}>{document.available?<Link className="link" to={`/app/documents/${document.id}`}>{document.name||`Document ${document.index}`}</Link>:<span>Document {document.index} · Deleted</span>}<span className="small muted">Original pages {pageRange(document.originalPageStart,document.originalPageEnd)} · {document.pageCount} page{document.pageCount===1?'':'s'}</span></li>)}</ol><p className="small muted">{receipt.split.sourceAvailable?'The full original PDF remains available from a retained document, including omitted pages.':'The full original PDF is no longer available.'}</p></section>:<>
      {pending&&<div className="pdf-split-recovery"><h3>Resume this split</h3><p className="small">Saved selection: {describe(pending.options)}. Retry keeps the same request and does not create a second batch.</p><Button type="button" variant="secondary" disabled={busy} onClick={()=>void check()}>Check split result</Button></div>}
      <Field label={pending?'Reselect the same PDF':'PDF to split'} hint={`One PDF, up to 10 MB and ${pdfSplitLimits.maxPages} pages. Preview stays on this device until you submit.`}><input ref={fileInput} type="file" accept=".pdf,application/pdf" disabled={busy} onChange={event=>void chooseFile(event.target.files?.[0])}/></Field>
      {file&&<p className="small pdf-split-filename">{file.name}{pageCount?` · ${pageCount} pages`:''}</p>}
      <div className="pdf-split-mobile-tabs"><Tabs items={['Ranges','Preview']} value={tab} onChange={setTab} label="PDF split view"/></div>
      <div className={`pdf-split-columns mobile-${tab.toLowerCase()}`}><section className="pdf-split-controls" aria-label="Split settings">
        {!pending&&<fieldset className="pdf-split-modes" disabled={busy}><legend>Split by</legend><label><input type="radio" name="pdf-split-mode" value="every" checked={mode==='every'} onChange={()=>setMode('every')}/>Every N pages</label><label><input type="radio" name="pdf-split-mode" value="ranges" checked={mode==='ranges'} onChange={adjustRanges}/>Custom page ranges</label><label><input type="radio" name="pdf-split-mode" value="marker" checked={mode==='marker'} onChange={()=>setMode('marker')}/>Text marker</label></fieldset>}
        {!pending&&(mode==='every'?<Field label="Pages per document" hint="The final document may contain fewer pages."><input type="number" min={1} max={pdfSplitLimits.maxPages} step={1} value={every} disabled={busy} onChange={event=>setEvery(event.target.value)}/></Field>:mode==='ranges'?<Field label="Page ranges" hint="For example: 1-2, 5, 7-9. Each range creates one document. Keep ranges in order, without overlaps."><input value={ranges} placeholder="1-2, 5, 7-9" disabled={busy} maxLength={400} onChange={event=>setRanges(event.target.value)}/></Field>:<Field label="Text marker" hint="Exact, case-sensitive text (1–200 characters). Spaces and line breaks count as one space."><input value={marker} disabled={busy} maxLength={200} autoComplete="off" spellCheck={false} placeholder="Invoice number" onChange={event=>setMarker(event.target.value)}/></Field>)}
        {markerMode&&<div className="pdf-split-marker-info"><p className="small">Each matching page starts a document. Pages before the first match stay together.</p><p className="small muted">Uses searchable PDF text. Pages containing only images are retained; use custom ranges for boundaries found only in an image.</p>{file&&!nativePages&&!textError&&<p className="small" role="status">Reading searchable text on this device…</p>}{markerPlan&&<p className="small pdf-split-marker-matches" role="status"><strong>Marker found on pages {markerPlan.matchedPages.join(', ')}.</strong>{markerPlan.textlessPages.length>0&&<span> No searchable text on pages {markerPlan.textlessPages.join(', ')}. These pages stay in the ranges below; inspect them before creating documents.</span>}</p>}{nativePages&&!markerPlan&&nativePages.some(text=>!text.trim())&&nativePages.some(text=>text.trim())&&<p className="small">Pages without searchable text: {nativePages.flatMap((text,index)=>text.trim()?[]:[index+1]).join(', ')}. Check custom ranges if a boundary falls on one of these pages.</p>}</div>}
        {planError&&<Notice error={planError}/>}
        {!pending&&markerPlan&&<Button type="button" variant="secondary" disabled={busy} onClick={adjustRanges}>Adjust page ranges</Button>}
        {plan&&<><div className="pdf-split-quota" role="status"><strong>{plan.ranges.length} document{plan.ranges.length===1?'':'s'} · {plan.selectedPages} of {pageCount} pages selected</strong><p>Uses {plan.selectedPages} page credit{plan.selectedPages===1?'':'s'}. The full PDF is not queued separately. The server checks the actual pages before accepting the split.</p>{omitted.length>0&&<p><strong>Omitted pages: {omitted.join(', ')}.</strong> These pages will not become documents or use page credits.</p>}</div><ol className="pdf-split-parts">{plan.ranges.map((range,index)=><li key={index}><button type="button" disabled={busy} onClick={()=>{setPage(range.start);setTab('Preview');}}><strong>Document {index+1}</strong><span>Original pages {pageRange(range.start,range.end)} · {range.end-range.start+1} page{range.end===range.start?'':'s'}</span></button></li>)}</ol></>}
      </section><section className="pdf-split-preview" aria-label="PDF preview"><div className="pdf-split-preview-toolbar"><Button type="button" variant="ghost" aria-label="Previous PDF page" disabled={!pageCount||page<=1} onClick={()=>setPage(page-1)}><ChevronLeft/></Button><span>Page {pageCount?page:0} of {pageCount}</span><Button type="button" variant="ghost" aria-label="Next PDF page" disabled={!pageCount||page>=pageCount} onClick={()=>setPage(page+1)}><ChevronRight/></Button></div>{bytes?<PdfCanvas key={sha256} bytes={bytes} page={page} label={`PDF preview, original page ${page}`} readNativeText={markerMode} onNativeText={pages=>{if(previewGeneration!==selectionGeneration.current)return;setNativePages(pages);setTextError('');}} onNativeTextError={message=>{if(previewGeneration!==selectionGeneration.current)return;setNativePages(null);setTextError(message);}} onReady={count=>{if(previewGeneration!==selectionGeneration.current)return;setPageCount(count);}} onRendered={rendered=>{if(previewGeneration!==selectionGeneration.current)return;setReading(false);setRenderedPage(rendered);}} onError={message=>{if(previewGeneration!==selectionGeneration.current)return;setReading(false);setRenderedPage(null);setPageCount(0);setNativePages(null);setError(message);}}/>:<p className="small muted">Choose a PDF to inspect its pages.</p>}</section></div>
      <p className="small pdf-split-retention">The full original PDF is retained, including omitted pages and pages from deleted documents, while any document in this batch remains. To remove the full source, delete the whole batch from document review.</p>
      <div className="actions pdf-split-submit"><Button type="button" disabled={busy||!ready||!eligible} onClick={()=>void submit()}>{busy?'Checking split…':frozen?'Retry same split':plan?`Create ${plan.ranges.length} document${plan.ranges.length===1?'':'s'} from ${plan.selectedPages} pages`:'Create split documents'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{pending?'Close for now':'Cancel'}</Button></div>
      {!eligible&&<p className="small muted">This parser cannot accept a new split right now. Existing results can still be checked. Restore the parser, complete field setup, and allow PDF before retrying an incomplete upload.</p>}
    </>}
    {(pending||receipt)&&<div className="pdf-split-new">{confirmNew?<><p>{receipt?'A new split is a separate upload and uses new page credits.':'The earlier request may still finish. Starting a new split can create another batch and use additional page credits. Check the result first.'}</p><div className="actions"><Button type="button" variant="secondary" disabled={busy||!eligible} onClick={startNew}>Start new split anyway</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setConfirmNew(false)}>Keep this request</Button></div></>:<div className="actions"><Button type="button" variant="ghost" disabled={busy||!eligible} onClick={()=>setConfirmNew(true)}>Start a new split</Button>{receipt&&<Button type="button" variant="secondary" onClick={onClose}>Done</Button>}</div>}</div>}
  </div>;
}
