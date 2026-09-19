import {useLayoutEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {useQueryClient} from '@tanstack/react-query';
import {Archive} from 'lucide-react';
import {Button,Field,Modal,Notice} from '../../components/ui';
import {useSession} from '../../lib/session';
import {pdfSha256} from '../../lib/pdf-split';
import {clearPendingArchiveImport,findArchiveImportReceipt,previewArchiveImport,readPendingArchiveImport,saveMatchingArchiveImport,savePendingArchiveImport,uploadArchiveImport,type PendingArchiveImport} from '../../lib/archive-import';
import {archiveImportLimits,type ArchivePreview,type ArchiveImportReceipt,type ArchivePreviewEntry} from '../../../shared/archive-import';
import {sourceFormats} from '../../../shared/source-formats';
import type {SplitParser} from './SplitPdf';
import './archive-import.css';
const bytesLabel=(size:number)=>size<1024?`${size} B`:size<1024*1024?`${Math.ceil(size/1024)} KB`:`${(size/1024/1024).toFixed(1)} MB`;

export default function ImportZip({parser,disabled=false,onComplete}:{parser:SplitParser;disabled?:boolean;onComplete?:()=>void}){
  const session=useSession().data,[open,setOpen]=useState(false),[locked,setLocked]=useState(false),lock=useRef(false);
  if(!session||!['owner','admin','editor'].includes(session.workspace.role))return null;
  const user=session.user.id,workspace=session.workspace.id,pending=readPendingArchiveImport(user,workspace,parser.id),eligible=!parser.archived&&parser.fieldSetupState==='ready';
  return <div className="archive-import-entry"><Button type="button" variant="secondary" disabled={disabled||locked||!eligible&&!pending} onClick={()=>setOpen(true)}><Archive/>{pending?'Resume ZIP import':'Import ZIP'}</Button>{!eligible&&<p className="small muted">{parser.archived?'Restore this parser before importing a ZIP.':'Finish field setup before importing a ZIP.'} <Link className="link" to={`/app/parsers/${parser.id}?tab=${parser.archived?'settings':'setup'}`}>Open parser {parser.archived?'settings':'setup'}</Link></p>}<Modal title="Import ZIP" description={`Choose files to create separate documents in ${parser.name}.`} open={open} onOpenChange={value=>{if(!lock.current)setOpen(value);}}><ArchiveImportFlow key={`${user}:${workspace}:${parser.id}:${session.workspace.role}`} user={user} workspace={workspace} parser={parser} eligible={eligible} onLock={value=>{lock.current=value;setLocked(value);}} onClose={()=>setOpen(false)} onComplete={onComplete}/></Modal></div>;
}
function ArchiveImportFlow({user,workspace,parser,eligible,onLock,onClose,onComplete}:{user:string;workspace:string;parser:SplitParser;eligible:boolean;onLock:(value:boolean)=>void;onClose:()=>void;onComplete?:()=>void}){
  const client=useQueryClient(),mounted=useRef(true),generation=useRef(0),operation=useRef('idle'),input=useRef<HTMLInputElement>(null),errorContainer=useRef<HTMLDivElement>(null);
  const [pending,setPending]=useState<PendingArchiveImport|null>(()=>readPendingArchiveImport(user,workspace,parser.id));
  const [file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<ArchivePreview|null>(null),[selected,setSelected]=useState<number[]>([]),[phase,setPhase]=useState('idle');
  const [receipt,setReceipt]=useState<ArchiveImportReceipt|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmNew,setConfirmNew]=useState(false);
  const current=(value:number)=>mounted.current&&generation.current===value;
  function begin(value:string){operation.current=value;setPhase(value);onLock(value==='import');}
  function persist(value:PendingArchiveImport){savePendingArchiveImport(value);setPending(value);}
  function received(value:ArchiveImportReceipt){setReceipt(value);setError('');setNotice('');void client.invalidateQueries();onComplete?.();}
  async function check(value=pending){
    if(!value?.options||operation.current!=='idle')return;const active=generation.current;begin('check');setError('');setNotice('Checking import result…');
    try{const result=await findArchiveImportReceipt(value,()=>current(active));if(!current(active))return;if(result)received(result);else setNotice('No completed import was found yet. Reselect the same ZIP, preview it, then retry this request.');}
    catch(cause){if(current(active)){setNotice('');setError(cause instanceof Error?cause.message:'The import could not be checked.');}}
    finally{if(current(active))begin('idle');}
  }
  useLayoutEffect(()=>{mounted.current=true;if(pending?.options)void check(pending);return()=>{mounted.current=false;generation.current++;operation.current='idle';onLock(false);};},[]);
  useLayoutEffect(()=>{if(error&&mounted.current)errorContainer.current?.scrollIntoView({block:'nearest',behavior:'instant'});},[error]);
  async function chooseFile(next:File|undefined){
    if(!next||operation.current==='import')return;const active=++generation.current;begin('reading');setFile(null);setPreview(null);setSelected([]);setReceipt(null);setNotice('');setError('');
    try{
      if(next.size<1||next.size>archiveImportLimits.maxBytes)throw new Error('Choose a ZIP with data, up to 10 MB.');
      const sha256=await pdfSha256(await next.arrayBuffer());if(!current(active))return;
      if(pending?.options&&(pending.sha256!==sha256||pending.byteSize!==next.size))throw new Error('This is a different file. Reselect the original ZIP to resume this request, or explicitly start a new import.');
      const value:PendingArchiveImport=pending&&pending.sha256===sha256&&pending.byteSize===next.size?pending:{version:1,userId:user,workspaceId:workspace,parserId:parser.id,requestId:crypto.randomUUID(),sha256,byteSize:next.size};
      persist(value);setFile(next);
    }catch(cause){if(current(active))setError(cause instanceof Error?cause.message:'The ZIP could not be read.');}
    finally{if(current(active))begin('idle');}
  }
  const allowed=(entry:ArchivePreviewEntry)=>entry.status==='ready'&&entry.format!==null&&(parser.allowedFormats==null||parser.allowedFormats.includes(entry.format));
  const selectedEntries=preview?.entries.filter(entry=>selected.includes(entry.index))||[],selectedPages=selectedEntries.reduce((sum,entry)=>sum+(entry.pageCount||0),0);
  const frozen=Boolean(pending?.options),busy=phase!=='idle',selectable=preview?.entries.filter(allowed)||[],unavailable=preview?.entries.filter(entry=>!allowed(entry))||[];
  const ready=Boolean(file&&pending&&preview&&preview.sourceSha256===pending.sha256&&selected.length&&selected.length<=archiveImportLimits.maxDocuments&&selectedEntries.length===selected.length&&selectedEntries.every(allowed)&&(!frozen||selectedPages===pending?.selectedPages)&&!busy&&eligible);
  async function inspect(){
    if(!file||!pending||operation.current!=='idle'||!eligible)return;const active=generation.current,value=pending;begin('preview');setPreview(null);setSelected([]);setError('');setNotice('Uploading ZIP for a server preview…');
    try{
      const result=await previewArchiveImport(value,file,next=>{if(current(active))persist(next);else saveMatchingArchiveImport(next);},()=>current(active));if(!current(active))return;
      setPreview(result);setSelected(value.options?.entries||result.entries.filter(allowed).map(entry=>entry.index));setNotice('');
      if(value.options&&value.options.entries.some(index=>!result.entries.some(entry=>entry.index===index&&allowed(entry))))setError('Some files in the saved selection are unavailable. Check the existing result before starting a new import.');
    }catch(cause){if(current(active)){setNotice('');setError(cause instanceof Error?cause.message:'The ZIP preview could not be completed.');}}
    finally{if(current(active))begin('idle');}
  }
  async function submit(){
    if(!ready||!pending||!file||operation.current!=='idle')return;const active=generation.current;begin('import');setError('');setNotice('Importing selected files…');let value=pending;
    try{
      if(!value.options){value={...value,options:{mode:'zip',version:1,sourceSha256:value.sha256,entries:[...selected].sort((a,b)=>a-b)},selectedPages};persist(value);}
      const result=await uploadArchiveImport(value,file,next=>{if(current(active))persist(next);else saveMatchingArchiveImport(next);},()=>current(active));if(current(active))received(result);
    }catch(cause){
      if(!current(active))return;setNotice('');const message=cause instanceof TypeError?'The import could not be confirmed. Check your connection and try again.':cause instanceof Error?cause.message:'The import could not be confirmed.';
      try{const result=await findArchiveImportReceipt(value,()=>current(active));if(!current(active))return;if(result){received(result);return;}}catch{/* Preserve the initial failure and the original request. */}
      if(current(active))setError(`${message}${/[.!?]$/.test(message)?'':'.'} Your saved request is retained. Check its result before starting another import.`);
    }finally{if(current(active))begin('idle');}
  }
  function startNew(){
    if(operation.current==='import')return;
    try{clearPendingArchiveImport(user,workspace,parser.id);generation.current++;begin('idle');setPending(null);setFile(null);setPreview(null);setSelected([]);setReceipt(null);setConfirmNew(false);setNotice('');setError('');if(input.current)input.current.value='';}
    catch{setError('The saved request could not be cleared. Enable browser session storage to start another import.');}
  }
  return <div className="archive-import-dialog" aria-busy={busy}><div ref={errorContainer}><Notice error={error} message={notice}/></div>{receipt?<section aria-label="ZIP import result"><h3>{receipt.archive.childCount} document{receipt.archive.childCount===1?'':'s'} received · {receipt.archive.totalPages} page{receipt.archive.totalPages===1?'':'s'}</h3><p>{receipt.replayed?'This is the existing import. Replaying it uses no additional page credits.':'The selected files were received. Processing continues in the background.'} Review and approve each document before exporting.</p><ol className="archive-import-receipt">{receipt.documents.map(document=><li key={document.id}>{document.available?<Link className="link" to={`/app/documents/${document.id}`}>{document.path||document.name}</Link>:<span>Archive entry {document.index} · Deleted</span>}<span className="small muted">Entry {document.index} · {document.pageCount} page{document.pageCount===1?'':'s'}</span></li>)}</ol><p className="small">{receipt.archive.sourceAvailable?'The full original ZIP remains available from any retained document. It includes every excluded file and deleted document.':'The full original ZIP is no longer available.'}</p></section>:<>
    {frozen&&<div className="archive-import-recovery"><h3>Resume this import</h3><p className="small">Saved selection: {pending!.options!.entries.length} files · {pending!.selectedPages} page credits. This request keeps the same source and selection.</p><Button type="button" variant="secondary" disabled={busy} onClick={()=>void check()}>Check import result</Button></div>}
    <Field label={frozen?'Reselect the same ZIP':'ZIP to import'} hint="One ZIP, up to 10 MB and 20 document files. Preview inspects it on the server without creating documents or page charges."><input ref={input} type="file" accept=".zip,application/zip" disabled={phase==='import'} onChange={event=>void chooseFile(event.target.files?.[0])}/></Field>{file&&<p className="small archive-import-filename">{file.name} · {bytesLabel(file.size)}</p>}
    <Button type="button" variant="secondary" disabled={!file||busy||!eligible} onClick={()=>void inspect()}>{phase==='preview'?'Inspecting ZIP…':preview?'Refresh ZIP preview':'Preview ZIP'}</Button>
    {preview&&<section className="archive-import-selection" aria-label="Files in ZIP"><div className="archive-import-selection-heading"><h3>{preview.entries.length} files in this ZIP</h3><p className="small">Choose supported files to import. Unavailable files remain listed. A PDF stays whole; DOCX and XLSX each stay one document.</p>{!frozen&&<div className="actions"><Button type="button" variant="ghost" disabled={busy||!selectable.length} onClick={()=>setSelected(selectable.map(entry=>entry.index))}>Select supported files</Button><Button type="button" variant="ghost" disabled={busy||!selected.length} onClick={()=>setSelected([])}>Clear selection</Button></div>}</div><ul className="archive-import-files">{preview.entries.map(entry=>{const canSelect=allowed(entry),reason=!canSelect?(entry.reason||'This format is not currently accepted by this parser.'):null;return <li key={entry.index} className={!canSelect?'unavailable':undefined}><label><input type="checkbox" checked={selected.includes(entry.index)} disabled={busy||frozen||!canSelect} aria-label={`${canSelect?'Import':'Unavailable'} ${entry.path}`} onChange={event=>setSelected(current=>event.target.checked?[...current,entry.index].sort((a,b)=>a-b):current.filter(index=>index!==entry.index))}/><span className="archive-import-file"><strong>{entry.path}</strong><span className="small muted">Entry {entry.index} · {bytesLabel(entry.byteSize)}{entry.format?` · ${sourceFormats.find(format=>format.id===entry.format)?.label||entry.format}`:''}{entry.pageCount!==null?` · ${entry.pageCount} page${entry.pageCount===1?'':'s'}`:''}</span>{reason&&<span className="small archive-import-reason">{reason}</span>}</span></label></li>;})}</ul><div className="archive-import-total" role="status"><strong>{selected.length} of {preview.entries.length} files selected · {selectedPages} page credit{selectedPages===1?'':'s'}</strong><p className="small">{unavailable.length>0?`${unavailable.length} unavailable file${unavailable.length===1?' is':'s are'} excluded. `:''}Only selected files become documents. The ZIP itself uses no extra page credits.</p></div>{!selected.length&&<p className="small">Select at least one supported file to import.</p>}{selected.length>archiveImportLimits.maxDocuments&&<p className="small" role="alert">Select no more than 20 files for one import.</p>}{selectedEntries.some(entry=>!allowed(entry))&&<p className="small" role="alert">The parser no longer accepts a selected file. Refresh the preview before continuing.</p>}</section>}
    <p className="small archive-import-retention">The full original ZIP is retained while any imported document remains. It still contains every excluded, unsupported and metadata file, including files from deleted documents. Delete the whole import from document review to remove that original.</p>
    <div className="actions archive-import-submit"><Button type="button" disabled={!ready} onClick={()=>void submit()}>{phase==='import'?'Importing…':frozen?'Retry same import':`Import ${selected.length||'selected'} file${selected.length===1?'':'s'}`}</Button><Button type="button" variant="ghost" disabled={phase==='import'} onClick={onClose}>{pending?'Close for now':'Cancel'}</Button></div>{!eligible&&<p className="small muted">Restore the parser and complete field setup before previewing or importing. Existing results can still be checked.</p>}
  </>}{pending&&<div className="archive-import-new">{confirmNew?<><p>{frozen&&!receipt?'This request may still finish. Starting another import can create another batch and use additional page credits. Check its result first.':'A new import uses a separate request. Accepted files use new page credits.'}</p><div className="actions"><Button type="button" variant="secondary" disabled={phase==='import'||!eligible} onClick={startNew}>Start new import anyway</Button><Button type="button" variant="ghost" onClick={()=>setConfirmNew(false)}>Keep this request</Button></div></>:<div className="actions"><Button type="button" variant="ghost" disabled={phase==='import'||!eligible} onClick={()=>setConfirmNew(true)}>Start a new import</Button>{receipt&&<Button type="button" variant="secondary" onClick={onClose}>Done</Button>}</div>}</div>}</div>;
}
