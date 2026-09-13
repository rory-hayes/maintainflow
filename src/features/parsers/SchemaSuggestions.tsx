import {useId,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import type {SchemaSuggestion} from '../../../shared/schema-suggestions';
import type {FieldType,SchemaField} from '../../../shared/types';
import {Button,Field,Notice,Status,dateTime} from '../../components/ui';
import {api,ApiError,post,useAction,useData,workspaceId} from '../../lib/api';
import './schema-suggestions.css';

export const fieldTypeLabels:Record<FieldType,string>={string:'Text',number:'Number',currency:'Currency amount',date:'Date',boolean:'Boolean',multiline:'Multiline text',array:'Table / array',object:'Nested object'};
interface SuggestionList {suggestions:SchemaSuggestion[];available:boolean;limits:{perDay:number;pendingPerWorkspace:number};}
interface DocumentList {documents:{id:string;name:string}[];total:number;page:number;pageSize:number;}
const pending=(suggestion:SchemaSuggestion)=>suggestion.state==='queued'||suggestion.state==='processing';

function SuggestedFields({fields}:{fields:SchemaField[]}){
  return <ul className="suggested-fields">{fields.map(field=><li key={field.key}>
    <div><strong>{field.label}</strong><span>{fieldTypeLabels[field.type]}</span><code>{field.key}</code></div>
    {field.instructions&&<p>{field.instructions}</p>}
    {field.fields?.length? <SuggestedFields fields={field.fields}/>:null}
  </li>)}</ul>;
}

export default function SchemaSuggestions({parserId,baseSchemaId,canEdit,archived=false,blocked=false,activeSuggestionId,onUse,onConflict,onUploadDocument}:{
  parserId:string;baseSchemaId:string;canEdit:boolean;archived?:boolean;blocked?:boolean;activeSuggestionId?:string;
  onUse:(suggestion:SchemaSuggestion)=>void;onConflict:()=>void;onUploadDocument:()=>void;
}){
  const client=useQueryClient(),path=`/api/parsers/${parserId}/schema-suggestions`,queryKey=[workspaceId(),path];
  const history=useQuery<SuggestionList>({queryKey,queryFn:({signal})=>api<SuggestionList>(path,{signal}),refetchInterval:query=>query.state.data?.suggestions.some(pending)?2000:false});
  const [page,setPage]=useState(1),[documentId,setDocumentId]=useState(''),[previewId,setPreviewId]=useState<string|null>(null);
  const documents=useData<DocumentList>(`/api/parsers/${parserId}/documents?page=${page}&pageSize=20`);
  const request=useRef<{documentId:string;baseSchemaId:string;requestId:string}|null>(null);
  const action=useAction(),descriptionId=useId(),previewPrefix=useId();
  const available=history.data?.available===true&&!history.error;
  const disabled=!canEdit||archived||blocked||action.busy||!available;
  async function queueSuggestion(){
    if(disabled||!documentId)return;
    if(request.current?.documentId!==documentId||request.current?.baseSchemaId!==baseSchemaId)request.current={documentId,baseSchemaId,requestId:crypto.randomUUID()};
    const body=request.current;
    await action.run(async()=>{
      try{
        const result=await post<{suggestion:SchemaSuggestion}>(path,body);
        request.current=null;
        client.setQueryData<SuggestionList>(queryKey,current=>current?{...current,suggestions:[result.suggestion,...current.suggestions.filter(item=>item.id!==result.suggestion.id)].slice(0,10)}:current);
        setPreviewId(result.suggestion.id);
        return result;
      }catch(error){if(error instanceof ApiError&&error.status===409)onConflict();throw error;}
    },'Suggestion requested. You can leave this page and return to its progress below.');
  }
  return <section className="schema-suggestions panel" aria-labelledby={`${descriptionId}-heading`}>
    <div className="schema-suggestions-heading"><h2 id={`${descriptionId}-heading`}>Suggest fields from a document</h2><span className="small muted">AI draft</span></div>
    <p>Choose a document already in this parser. Review the suggested fields, edit them, then save when you are ready.</p>
    <p className="small muted" id={descriptionId}>The selected document is sent to the configured AI provider to suggest fields. No extra document-page credits are used. 10 suggestions per workspace every 24 hours.</p>
    {history.isPending&&<p className="small muted" role="status">Checking field suggestions…</p>}
    {history.error&&<div><Notice error={history.error.message}/><Button type="button" variant="secondary" onClick={()=>void history.refetch()}>Retry suggestions</Button></div>}
    {history.data&&!history.error&&!history.data.available&&<p className="schema-suggestion-help" role="status">AI field suggestions need provider setup. You can keep editing fields manually.</p>}
    {!canEdit&&<p className="small muted">An editor, admin or owner can request and use suggested fields.</p>}
    {archived&&canEdit&&<p className="small muted">Restore this parser to request a new suggestion.</p>}
    {canEdit&&<div className="schema-suggestion-request">
      {documents.isPending?<p className="small muted" role="status">Loading documents…</p>:documents.error?<div><Notice error={documents.error.message}/><Button type="button" variant="secondary" onClick={()=>void documents.refetch()}>Retry documents</Button></div>:documents.data?.total===0?<div><p className="small">Upload a document to this parser to suggest its fields.</p><Button type="button" variant="secondary" onClick={onUploadDocument} disabled={archived}>Add a document</Button></div>:<>
        <div className="schema-suggestion-source"><Field label="Source document"><select value={documentId} disabled={disabled||documents.isFetching} aria-describedby={descriptionId} onChange={event=>{setDocumentId(event.target.value);request.current=null;action.setError('');action.setMessage('');}}><option value="">Choose a document</option>{documents.data?.documents.map(document=><option key={document.id} value={document.id}>{document.name}</option>)}</select></Field>
          <Button type="button" disabled={disabled||!documentId||documents.isFetching} onClick={()=>void queueSuggestion()}>{action.busy?'Requesting…':'Suggest fields'}</Button>
        </div>
        {documents.data&&documents.data.total>20&&<div className="schema-suggestion-pages"><span>Document page {page} of {Math.ceil(documents.data.total/20)}</span><div className="actions"><Button type="button" variant="secondary" disabled={page===1||action.busy||documents.isFetching} onClick={()=>{setPage(current=>current-1);setDocumentId('');request.current=null;}}>Previous documents</Button><Button type="button" variant="secondary" disabled={page*20>=documents.data.total||action.busy||documents.isFetching} onClick={()=>{setPage(current=>current+1);setDocumentId('');request.current=null;}}>Next documents</Button></div></div>}
      </>}
      <Notice error={action.error} message={action.message}/>
    </div>}
    {history.data&&<div className="schema-suggestion-history"><h3>Recent suggestions</h3>
      {!history.data.suggestions.length&&<p className="small muted">No suggestions yet. Your saved fields stay unchanged until you save a reviewed draft.</p>}
      <ul>{history.data.suggestions.map(suggestion=>{
        const ready=suggestion.state==='ready'&&suggestion.schema!==null,expanded=previewId===suggestion.id,stale=suggestion.baseSchemaId!==baseSchemaId;
        return <li key={suggestion.id} className="schema-suggestion-item">
          <div className="schema-suggestion-item-heading"><div><Link className="link" to={`/app/documents/${suggestion.documentId}`}>{suggestion.documentName}</Link><span className="small muted">{dateTime(suggestion.createdAt)}</span></div><Status value={suggestion.appliedSchemaId?'applied':suggestion.state}/></div>
          {pending(suggestion)&&<p className="small muted" role="status">{suggestion.state==='queued'?'Waiting to suggest fields…':'Reading the document and preparing suggested fields…'} You can return later; progress is saved.</p>}
          {suggestion.state==='failed'&&<p className="small">{suggestion.error?.slice(0,300)||'The suggestion could not be prepared. You can request another suggestion from this document.'}</p>}
          {ready&&<>
            {suggestion.appliedSchemaId?<p className="small muted">Saved as a schema version. <Link className="link" to={`/app/documents/${suggestion.documentId}`}>Open the source document</Link> and choose Reprocess to try your current saved fields, then review the result.</p>:activeSuggestionId===suggestion.id?<p className="small" role="status">Loaded in the editor below. Review your draft and save to apply it.</p>:stale?<p className="small muted">This suggestion used an earlier schema version. Request a new suggestion for the current fields.</p>:null}
            <Button type="button" variant="secondary" aria-expanded={expanded} aria-controls={`${previewPrefix}-${suggestion.id}`} onClick={()=>setPreviewId(expanded?null:suggestion.id)}>{expanded?'Hide suggested fields':'Review suggested fields'}</Button>
            {expanded&&<div id={`${previewPrefix}-${suggestion.id}`} className="schema-suggestion-preview"><SuggestedFields fields={suggestion.schema!.fields}/>{!suggestion.appliedSchemaId&&<Button type="button" disabled={!canEdit||blocked||stale||activeSuggestionId===suggestion.id} onClick={()=>onUse(suggestion)}>{activeSuggestionId===suggestion.id?'Loaded in editor':'Use suggested fields'}</Button>}<p className="small muted">AI can miss or misinterpret fields. Check names, types and nested fields before saving. Existing documents are not reprocessed automatically.</p></div>}
          </>}
        </li>;
      })}</ul>
    </div>}
  </section>;
}
