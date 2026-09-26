import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {Upload,FileText,ArrowRight,RotateCw,Download,CheckCircle2,AlertCircle} from 'lucide-react';
import {Button,Field,Notice,PageHeader,Loading,ErrorState,Status} from '../../components/ui';
import {post,uploadDocuments,useAction,useData} from '../../lib/api';
import {useSession} from '../../lib/session';
import {bankAccept,bankLocales,exportBankStatements,type BankDocument,type BankLocale} from './bank-ui';
import './bank-statements.css';

type Hub={documents:BankDocument[];parser?:{id:string;locale:string}|null;providerConfigured:boolean;total?:number;page?:number;pageSize?:number;limits?:{maxFiles?:number;maxBytes?:number;maxPages?:number}};
type UploadItem={key:string;file:File;state:'waiting'|'uploading'|'received'|'failed';documentId?:string;duplicate?:boolean;error?:string};
export default function BankStatements(){
  const [page,setPage]=useState(1),[search,setSearch]=useState(''),[searchDraft,setSearchDraft]=useState('');
  const query=useData<Hub>(`/api/bank-statements?page=${page}&pageSize=50${search?`&search=${encodeURIComponent(search)}`:''}`,2500),session=useSession().data;
  const canEdit=Boolean(session&&['owner','admin','editor'].includes(session.workspace.role));
  const [locale,setLocale]=useState<BankLocale>('en-IE'),[localeEdited,setLocaleEdited]=useState(false),[items,setItems]=useState<UploadItem[]>([]),[uploading,setUploading]=useState(false),[uploadError,setUploadError]=useState(''),[dragging,setDragging]=useState(false),[selected,setSelected]=useState<Record<string,string>>({});
  const input=useRef<HTMLInputElement>(null),busy=useRef(false),mounted=useRef(true);const action=useAction();
  // The shell remounts this screen on workspace changes; stop pending batch work there.
  const workspace=sessionStorage.getItem('folio.workspace');
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const activeLocale=localeEdited?locale:(bankLocales.some(([value])=>value===query.data?.parser?.locale)?query.data!.parser!.locale as BankLocale:locale);
  async function receive(files:File[],retryKey?:string){
    if(!files.length||busy.current||!canEdit)return;
    if(files.length>20){setUploadError('Choose up to 20 files at a time.');return;}
    const batchLocale=activeLocale;
    const batch:UploadItem[]=files.map(file=>({key:retryKey||crypto.randomUUID(),file,state:!file.size||file.size>10*1024*1024?'failed':'waiting',...(!file.size||file.size>10*1024*1024?{error:'Choose a non-empty file of 10 MB or less.'}:{})}));
    setItems(current=>retryKey?current.map(item=>item.key===retryKey?batch[0]:item):batch);setUploadError('');setUploading(true);busy.current=true;
    const stillHere=()=>mounted.current&&sessionStorage.getItem('folio.workspace')===workspace;
    try{
      if(!batch.some(item=>item.state==='waiting'))return;
      const setup=await post<{parser:{id:string}}>('/api/bank-statements/setup',{locale:batchLocale});
      for(const item of batch){
        if(item.state==='failed')continue;
        if(!stillHere())break;
        setItems(current=>current.map(row=>row.key===item.key?{...row,state:'uploading'}:row));
        try{
          const response=await uploadDocuments(setup.parser.id,[item.file],{bankLocale:batchLocale});
          if(!stillHere())break;
          const result=response.results?.[0]||response;
          if(result.error||!result.document?.id)throw new Error(result.error||'The upload could not be confirmed. Retry this file.');
          setItems(current=>current.map(row=>row.key===item.key?{...row,state:'received',documentId:result.document!.id,duplicate:result.duplicate}:row));
        }catch(error){if(stillHere())setItems(current=>current.map(row=>row.key===item.key?{...row,state:'failed',error:error instanceof Error?error.message:'Upload failed. Please retry.'}:row));}
        if(stillHere())await query.refetch();
      }
    }catch(error){if(stillHere()){const message=error instanceof Error?error.message:'Statement setup could not finish.';setUploadError(message);setItems(current=>current.map(row=>batch.some(item=>item.key===row.key)?{...row,state:'failed',error:message}:row));}}
    finally{busy.current=false;if(stillHere())setUploading(false);if(input.current)input.current.value='';}
  }
  if(query.isPending)return <Loading/>;
  if(query.error)return <ErrorState error={query.error} retry={()=>void query.refetch()}/>;
  const documents=query.data.documents;
  const revisions=Object.entries(selected).flatMap(([documentId,approvalId])=>approvalId?[{documentId,approvalId}]:[]);
  return <div className="bank-hub"><PageHeader title="Bank statements" description="Upload, check your transactions, then download a spreadsheet."/>
    <ol className="bank-workflow"><li className="active"><span>1</span>Upload statements</li><li><span>2</span>Review transactions</li><li><span>3</span>Approve & export</li></ol>
    <section className="bank-upload-card" aria-labelledby="bank-upload-heading"><div><p className="bank-eyebrow">Start here</p><h2 id="bank-upload-heading">Add your statements</h2><p>Dates, accounts and transaction columns are already set up for you.</p><Field label="How are dates and amounts written?" hint="This choice applies to newly uploaded statements. Existing results keep their original settings."><select aria-label="How are dates and amounts written?" disabled={uploading||!canEdit} value={activeLocale} onChange={event=>{setLocale(event.target.value as BankLocale);setLocaleEdited(true);}}>{bankLocales.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></Field></div>
      <div className={`bank-dropzone ${dragging?'dragging':''}`} onDragOver={event=>{event.preventDefault();if(!uploading&&canEdit)setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);void receive(Array.from(event.dataTransfer.files));}} aria-busy={uploading}><Upload size={30} strokeWidth={1.5}/><strong>{uploading?'Receiving your statements…':'Drop statements here'}</strong><p>Up to 20 files · 10 MB and 30 pages each</p><Button type="button" disabled={uploading||!canEdit} onClick={()=>input.current?.click()}>Choose files<ArrowRight size={17}/></Button><input ref={input} className="sr-only" type="file" accept={bankAccept} multiple disabled={uploading||!canEdit} tabIndex={-1} aria-label="Choose bank statements" onChange={event=>void receive(Array.from(event.target.files||[]))}/></div>
    </section><p className="small muted">PDF, PNG, JPEG, TIFF, text, CSV, XLSX, DOCX, HTML and EML. {query.data.providerConfigured?'AI extraction sends document content to the configured provider. Review every result against the original.':'AI extraction is not configured. Scans and images cannot be read until an owner configures the provider.'}</p><p className="small muted">Very dense statements can exceed extraction limits. Each account supports up to 1,000 extracted transaction rows; split larger statements into smaller files. Other document limits can still apply.</p>{!canEdit&&<p className="bank-callout">You have view-only access. An owner, admin or editor can upload and correct statements.</p>}<Notice error={uploadError}/>
    {items.length>0&&<section className="bank-upload-results" aria-label="Upload progress"><div className="bank-section-heading"><h2>Current upload</h2><span role="status">{items.filter(item=>item.state==='received'||item.state==='failed').length} of {items.length} received or checked</span></div><ul>{items.map(item=><li key={item.key}><FileText size={20}/><div><strong>{item.file.name}</strong><span>{item.state==='waiting'?'Waiting to upload':item.state==='uploading'?'Uploading and checking file…':item.state==='received'?item.duplicate?'Already uploaded · existing statement opened':'Received · processing in the background':item.error}</span></div>{item.state==='received'?<Link className="link" to={`/app/bank-statements/${item.documentId}`}>Open</Link>:item.state==='failed'?<Button variant="secondary" disabled={uploading} onClick={()=>void receive([item.file],item.key)}><RotateCw size={16}/>Retry</Button>:<span className="bank-label">{item.state==='uploading'?'In progress':'Waiting'}</span>}</li>)}</ul></section>}
    <section className="bank-statement-list" aria-labelledby="statements-heading"><div className="bank-section-heading"><h2 id="statements-heading">Your statements <span>{query.data.total??documents.length}</span></h2><div className="actions"><Button variant="secondary" disabled={!revisions.length||action.busy} onClick={()=>void action.run(()=>exportBankStatements('csv',revisions),'Approved CSV downloaded.')}><Download/>CSV{revisions.length?` (${revisions.length})`:''}</Button><Button variant="secondary" disabled={!revisions.length||action.busy} onClick={()=>void action.run(()=>exportBankStatements('xlsx',revisions),'Approved Excel file downloaded.')}>Excel</Button></div></div><p className="small muted">Select approved statements to download together. Each export uses the approval selected at that moment, even if a newer result appears. Selection is kept across pages.</p><form className="bank-search" onSubmit={event=>{event.preventDefault();setSearch(searchDraft.trim());setPage(1);}}><Field label="Find a statement"><input type="search" maxLength={100} value={searchDraft} placeholder="Search by filename" onChange={event=>setSearchDraft(event.target.value)}/></Field><Button variant="secondary" type="submit">Search</Button>{revisions.length>0&&<Button type="button" variant="ghost" onClick={()=>setSelected({})}>Clear selection ({revisions.length})</Button>}</form><Notice error={action.error} message={action.message}/>
      {documents.length?<div className="bank-document-cards">{documents.map(doc=><article key={doc.id} className="bank-document-card"><input type="checkbox" aria-label={`Select ${doc.name} for export`} disabled={!doc.bankSummary?.approvalId&&!selected[doc.id]} checked={Boolean(selected[doc.id])} onChange={event=>setSelected(current=>({...current,[doc.id]:event.target.checked?doc.bankSummary!.approvalId!:''}))}/><FileText size={24} strokeWidth={1.5}/><div className="bank-document-info"><Link to={`/app/bank-statements/${doc.id}`}><strong>{doc.name}</strong></Link><p>{doc.pageCount} page{doc.pageCount===1?'':'s'}{doc.bankSummary?.transactionCount!==undefined?` · ${doc.bankSummary.transactionCount} transactions`:''}{doc.bankSummary?.accountCount!==undefined?` · ${doc.bankSummary.accountCount} accounts`:''}</p>{doc.error&&<p className="bank-error-text">{doc.error}</p>}{Boolean(doc.bankSummary?.errorCount||doc.bankSummary?.warningCount)&&<p className="bank-check-count"><AlertCircle size={14}/>{doc.bankSummary?.errorCount||0} errors · {doc.bankSummary?.warningCount||0} warnings</p>}{selected[doc.id]&&selected[doc.id]!==doc.bankSummary?.approvalId&&<p className="bank-check-count">Earlier approval selected for export. Clear and select again to use the latest.</p>}</div><Status value={doc.status}/><Link className="button secondary" to={`/app/bank-statements/${doc.id}`}>{doc.bankSummary?.approvalId?<CheckCircle2 size={16}/>:null}Open<ArrowRight size={15}/></Link></article>)}</div>:<div className="bank-empty"><FileText size={35} strokeWidth={1.3}/><h3>Your first statement starts here.</h3><p>Upload a file above. When extraction finishes, open it to check the transactions before exporting.</p></div>}
      {(query.data.total??0)>50&&<nav className="bank-pagination" aria-label="Statement pages"><Button variant="secondary" disabled={page===1} onClick={()=>setPage(value=>value-1)}>Previous</Button><span>Page {page} of {Math.ceil((query.data.total||0)/50)}</span><Button variant="secondary" disabled={page*50>=(query.data.total||0)} onClick={()=>setPage(value=>value+1)}>Next</Button></nav>}
    </section>
  </div>;
}
