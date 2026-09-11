import {useRef,useState} from 'react';
import {Upload as UploadIcon} from 'lucide-react';
import {useNavigate} from 'react-router-dom';
import {Button,Notice,Field} from '../../components/ui';
import {api,post,useAction,useData} from '../../lib/api';
import {useSession} from '../../lib/session';
import {useAiAvailability} from '../../lib/ai';
type Parser={id:string;name:string;archived:boolean;mode:'rules'|'ai'};
type UploadResult={document?:{id:string};duplicate?:boolean;name?:string;error?:string};
export default function Upload({parserId,onComplete,compact=false}:{parserId?:string;onComplete?:()=>void;compact?:boolean}){
  const input=useRef<HTMLInputElement>(null);const [dragging,setDragging]=useState(false),[selectedParser,setSelectedParser]=useState(parserId||'');const action=useAction();const query=useData<{parsers:Parser[]}>('/api/parsers');const navigate=useNavigate();const ai=useAiAvailability();const canEdit=useSession().data?.workspace.role!=='viewer';
  const parsers=query.data?.parsers.filter(parser=>!parser.archived)||[];
  const activeParser=parserId?parsers.find(parser=>parser.id===parserId)?.id:parsers.find(parser=>parser.id===selectedParser)?.id||parsers[0]?.id;
  const chosenParser=parsers.find(parser=>parser.id===activeParser);
  async function upload(files:FileList|File[]|null){
    if(!files?.length||action.busy||!canEdit)return;
    if(!activeParser){action.setError('Choose an active parser before uploading.');return;}
    if(files.length>20){action.setError('Choose up to 20 files in one upload.');return;}
    const oversized=Array.from(files).filter(file=>file.size>10*1024*1024);
    if(oversized.length){action.setError(`Each file must be 10 MB or smaller: ${oversized.map(file=>file.name).join(', ')}`);return;}
    const response=await action.run(async()=>{const form=new FormData();Array.from(files).forEach(file=>form.append('files',file));return api<UploadResult&{results:UploadResult[]}>(`/api/parsers/${activeParser}/documents`,{method:'POST',body:form,headers:{'Idempotency-Key':crypto.randomUUID()}});},'');
    if(input.current)input.current.value='';
    if(!response)return;
    const results=response.results||[response],accepted=results.filter(result=>result.document),failures=results.filter(result=>result.error),duplicates=accepted.filter(result=>result.duplicate).length;
    const summary=`${accepted.length} document${accepted.length===1?'':'s'} received${duplicates?` (${duplicates} already present)`:''}.`;
    if(failures.length)action.setError(`${summary} ${failures.map(result=>`${result.name||'File'}: ${result.error}`).join(' ')}`);
    else action.setMessage(`${summary} Processing continues in the background.`);
    if(accepted.length)onComplete?.();
    if(compact&&accepted.length===1&&!failures.length)navigate(`/app/documents/${accepted[0].document!.id}`);
  }
  return <div>{!parserId&&parsers.length>1&&<Field label="Upload to parser"><select value={activeParser||''} disabled={action.busy||!canEdit} onChange={event=>setSelectedParser(event.target.value)}>{parsers.map(parser=><option key={parser.id} value={parser.id}>{parser.name}</option>)}</select></Field>}<div className={`dropzone ${dragging?'dragging':''}`} aria-busy={action.busy} onDragOver={event=>{event.preventDefault();if(!action.busy&&canEdit)setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);void upload(event.dataTransfer.files);}}><UploadIcon size={30} strokeWidth={1.6}/><strong>{action.busy?'Uploading documents…':'Drop documents here'}</strong><p>PDF, images, email and text · up to 20 files, 10 MB and 30 pages each</p><div className="actions"><Button type="button" variant="secondary" disabled={action.busy||!activeParser||!canEdit} onClick={()=>input.current?.click()}>Choose files</Button>{compact&&<Button type="button" variant="ghost" disabled={action.busy||!activeParser||!canEdit} onClick={()=>void action.run(async()=>{const result=await post<UploadResult>(`/api/parsers/${activeParser}/sample`);if(!result.document?.id)throw new Error('The sample was not received. Please try again.');onComplete?.();navigate(`/app/documents/${result.document.id}`);},'Sample received.')}>Use a synthetic sample</Button>}</div><input className="sr-only" ref={input} tabIndex={-1} disabled={action.busy||!canEdit} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.txt,.html,.htm,.eml,.csv,.docx,.xlsx" onChange={event=>void upload(event.target.files)} aria-label="Upload documents"/></div>{parserId&&query.data&&!activeParser&&<p className="small muted">This parser is archived. Restore it to receive more documents.</p>}<p className="small muted">{chosenParser?.mode==='ai'?`AI mode sends document content to the configured AI provider. ${ai.message}`:chosenParser?'Text-anchor mode reads labels and templates in readable text. Choose AI mode in parser settings for scans and images.':'Choose a parser to see its extraction mode.'}</p><Notice error={action.error||(query.error instanceof Error?query.error.message:undefined)} message={action.message}/></div>;
}
