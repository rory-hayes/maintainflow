import {useEffect,useId,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {Button,Field,Notice,Status} from '../../components/ui';
import {api,post,useAction,workspaceId} from '../../lib/api';

interface Setup {state:'ready'|'awaiting_sample'|'suggesting'|'failed';suggestionId:string|null;sourceDocumentId:string|null;sourceDocumentName:string|null;error:string|null;waitingDocuments:number;available:boolean;}
interface SetupResponse {setup:Setup;}
interface SetupDocuments {documents:{id:string;name:string}[];total:number;}
const titles={ready:'Your fields are ready',awaiting_sample:'Add your first sample',suggesting:'Setting up your parser',failed:'Sample setup needs your attention'};

export default function ParserSetup({parserId,canEdit,archived,onEditFields,onAddSample,onSettings,showAddSampleAction=true}:{parserId:string;canEdit:boolean;archived:boolean;onEditFields:()=>void;onAddSample:()=>void;onSettings:()=>void;showAddSampleAction?:boolean}){
  const client=useQueryClient(),path=`/api/parsers/${parserId}/setup`,queryKey=[workspaceId(),path];
  const query=useQuery<SetupResponse>({queryKey,queryFn:({signal})=>api<SetupResponse>(path,{signal}),refetchInterval:query=>['awaiting_sample','suggesting'].includes(query.state.data?.setup.state??'')?2000:false});
  const setup=query.data?.setup,headingId=useId(),[page,setPage]=useState(1),[chosenDocument,setChosenDocument]=useState('');
  const documents=useQuery<SetupDocuments>({queryKey:[workspaceId(),`/api/parsers/${parserId}/documents?page=${page}&pageSize=20`],queryFn:({signal})=>api(`/api/parsers/${parserId}/documents?page=${page}&pageSize=20`,{signal}),enabled:canEdit&&Boolean(setup&&['failed','awaiting_sample'].includes(setup.state))});
  const request=useRef<{documentId:string;requestId:string}|null>(null),observed=useRef(''),action=useAction();
  const signature=setup?`${setup.state}:${setup.suggestionId??''}`:'';
  useEffect(()=>{if(signature&&observed.current!==signature){observed.current=signature;void client.invalidateQueries({queryKey:[workspaceId(),`/api/parsers/${parserId}`]});}},[signature,client,parserId]);
  const documentId=chosenDocument||setup?.sourceDocumentId||'';
  async function retry(){
    if(!setup?.available||!canEdit||archived||!documentId||action.busy)return;
    if(request.current?.documentId!==documentId)request.current={documentId,requestId:crypto.randomUUID()};
    await action.run(async()=>{
      try{const result=await post<SetupResponse>(`${path}/retry`,request.current);client.setQueryData(queryKey,result);request.current=null;return result;}
      catch(error){void client.invalidateQueries({queryKey});throw error;}
    },'Sample setup restarted. Your progress is saved.');
  }
  if(query.isPending)return <section className="parser-setup panel"><p role="status">Loading parser setup…</p></section>;
  if(query.error)return <section className="parser-setup panel"><Notice error={query.error.message}/><div className="actions"><Button type="button" variant="secondary" onClick={()=>void query.refetch()}>Retry setup status</Button><Button type="button" variant="secondary" onClick={onEditFields}>{canEdit?'Choose fields yourself':'View fields'}</Button></div></section>;
  if(!setup)return null;
  const retryable=setup.state==='failed'||setup.state==='awaiting_sample';
  return <section className="parser-setup panel" aria-labelledby={headingId}>
    <div className="parser-setup-heading"><h2 id={headingId}>{titles[setup.state]}</h2><Status value={setup.state==='awaiting_sample'?'waiting for sample':setup.state==='suggesting'?'setting up':setup.state==='ready'?'ready':'failed'}/></div>
    {setup.state==='awaiting_sample'&&<p>The first accepted sample will go to AI to discover and save your initial fields, then extract the document. Choose a sample that represents the documents you expect to receive.</p>}
    {setup.state==='suggesting'&&<p role="status">AI is discovering your fields. Folio will save them and start extraction automatically. You can leave this page and return; setup progress is saved.</p>}
    {setup.state==='failed'&&<><p>Your initial fields could not be prepared. Retry with an uploaded sample or choose fields yourself to continue.</p><Notice error={setup.error?.slice(0,500)}/></>}
    {setup.state==='ready'&&<p>Your initial fields are saved. Extraction continues in the background. Review each result before approving or exporting.</p>}
    {setup.sourceDocumentId&&<p className="small">Setup source: <Link className="link" to={`/app/documents/${setup.sourceDocumentId}`}>{setup.sourceDocumentName||'View sample'}</Link></p>}
    {setup.state!=='ready'&&<p className="small muted">{setup.waitingDocuments} document{setup.waitingDocuments===1?'':'s'} waiting for fields. Field discovery uses no extra page credits; 10 suggestions per workspace every 24 hours.</p>}
    {archived&&<p className="small">This parser is archived. <Link className="link" to="/app/parsers">Restore it from Parsers</Link> before continuing sample setup.</p>}
    {!setup.available&&setup.state!=='ready'&&<div className="parser-setup-disclosure"><p>AI sample setup is unavailable. Retry after the AI connection is restored, or choose fields yourself. For readable text, you can switch to text-anchor rules in Settings before saving your fields.</p><div className="actions"><Button type="button" variant="secondary" onClick={()=>void query.refetch()}>Refresh setup</Button><Button type="button" variant="secondary" onClick={onSettings}>Open settings</Button></div></div>}
    {canEdit&&retryable&&<>
      {documents.isPending?<p className="small muted" role="status">Loading uploaded samples…</p>:documents.error?<div><Notice error={documents.error.message}/><Button type="button" variant="secondary" onClick={()=>void documents.refetch()}>Retry sample list</Button></div>:Boolean(documents.data?.total)&&<div className="parser-setup-retry">
        <div className="parser-setup-source"><Field label="Sample to use"><select value={documentId} disabled={action.busy||archived} onChange={event=>{setChosenDocument(event.target.value);request.current=null;action.setError('');}}><option value="">Choose an uploaded sample</option>{setup.sourceDocumentId&&!documents.data?.documents.some(document=>document.id===setup.sourceDocumentId)&&<option value={setup.sourceDocumentId}>{setup.sourceDocumentName||'Current sample'}</option>}{documents.data?.documents.map(document=><option key={document.id} value={document.id}>{document.name}</option>)}</select></Field><Button type="button" disabled={!documentId||!setup.available||archived||action.busy||documents.isFetching} onClick={()=>void retry()}>{action.busy?'Restarting…':'Retry sample setup'}</Button></div>
        {documents.data&&documents.data.total>20&&<div className="parser-setup-pages"><span className="small muted">Sample page {page} of {Math.ceil(documents.data.total/20)}</span><div className="actions"><Button type="button" variant="secondary" disabled={page===1||action.busy||documents.isFetching} onClick={()=>{setPage(current=>current-1);setChosenDocument('');}}>Previous samples</Button><Button type="button" variant="secondary" disabled={page*20>=documents.data.total||action.busy||documents.isFetching} onClick={()=>{setPage(current=>current+1);setChosenDocument('');}}>Next samples</Button></div></div>}
      </div>}
      <Notice error={action.error} message={action.message}/>
    </>}
    <div className="parser-setup-actions actions">
      {setup.state==='ready'&&setup.sourceDocumentId&&<Link className="button primary" to={`/app/documents/${setup.sourceDocumentId}`}>Review first document</Link>}
      {canEdit&&retryable&&showAddSampleAction&&<Button type="button" disabled={archived||action.busy} variant={setup.state==='awaiting_sample'?'primary':'secondary'} onClick={onAddSample}>{setup.state==='awaiting_sample'?'Add a sample':'Upload another sample'}</Button>}
      <Button type="button" variant="secondary" onClick={onEditFields}>{setup.state==='ready'?(canEdit?'Edit fields':'View fields'):(canEdit?'Choose fields yourself':'View fields')}</Button>
    </div>
    {setup.state!=='ready'&&<p className="small muted">Choosing fields yourself opens the editor. Saving your fields ends automatic setup and starts the waiting documents with your schema. Every extracted result still needs review.</p>}
  </section>;
}
