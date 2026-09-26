import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Download} from 'lucide-react';
import {Link} from 'react-router-dom';
import {signupTermsRecordResponseSchema,type SignupTermsRecordResponse} from '../../../shared/signup-terms';
import {Button,Notice,dateTime} from '../../components/ui';
import {useSession} from '../../lib/session';
import {TermsText} from '../auth/SignupTerms';

/** Personal account evidence is independent of the currently selected workspace or policy. */
export default function AccountTermsRecord(){
  const {data:session}=useSession(),userId=session?.user.id;
  const query=useQuery<unknown,Error,SignupTermsRecordResponse>({
    queryKey:['signup-terms-record',userId],enabled:Boolean(userId),retry:false,staleTime:0,
    queryFn:async({signal})=>{
      const response=await fetch('/api/auth/signup-terms/record',{signal,credentials:'same-origin',cache:'no-store',redirect:'error'});
      if(!response.ok)throw new Error('Account terms could not be loaded.');
      return response.json();
    },select:value=>signupTermsRecordResponseSchema.parse(value),
  });
  const pending=useRef<AbortController|null>(null),currentUser=useRef(userId);
  currentUser.current=userId;
  const [busy,setBusy]=useState(false),[downloadError,setDownloadError]=useState('');
  useEffect(()=>{setDownloadError('');setBusy(false);return()=>{pending.current?.abort();pending.current=null;};},[userId]);
  async function download(){
    if(!userId||pending.current||!query.isSuccess||!query.data.record)return;
    const controller=new AbortController();pending.current=controller;
    const current=()=>pending.current===controller&&!controller.signal.aborted&&currentUser.current===userId;
    setBusy(true);setDownloadError('');
    const timeout=setTimeout(()=>controller.abort(),20_000);
    try{
      const response=await fetch('/api/auth/signup-terms/record/download',{signal:controller.signal,credentials:'same-origin',cache:'no-store',redirect:'error'});
      if(!response.ok||(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()!=='text/plain')throw new Error('Download unavailable');
      const blob=await response.blob();if(!current())return;
      const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='signup-terms-record.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
    }catch{
      if(pending.current===controller&&currentUser.current===userId)setDownloadError('The signup terms record could not be downloaded. Please try again.');
    }finally{
      clearTimeout(timeout);
      if(pending.current===controller){pending.current=null;setBusy(false);}
    }
  }
  if(!userId)return <p><Link className="link" to="/sign-in">Sign in to view your signup terms record.</Link></p>;
  const record=query.isSuccess?query.data.record:undefined;
  return <section className="account-terms-record" aria-labelledby="account-terms-title">
    <h2 id="account-terms-title">Your signup terms record</h2>
    <p className="small muted">This is your personal account record, separate from workspace Checkout terms.</p>
    {query.isPending?<p role="status">Loading your signup terms record…</p>:query.isError?<><Notice error="We couldn’t load your signup terms record."/><Button type="button" variant="secondary" disabled={query.isFetching} onClick={()=>void query.refetch()}>Retry account terms</Button></>:record===null?<p>No signup terms acceptance record is available for this account. Earlier accounts may not have a record.</p>:null}
    {record?<>
      <dl><div><dt>Acceptance received</dt><dd><time dateTime={record.acceptedAt}>{dateTime(record.acceptedAt)}</time></dd></div><div><dt>Record saved</dt><dd><time dateTime={record.recordedAt}>{dateTime(record.recordedAt)}</time></dd></div></dl>
      <TermsText policy={record.policy} summary="Read the recorded signup terms"/>
      <p className="small">Agreement: {record.policy.agreementText}</p>
      <p className="small muted">{record.evidenceNotice}</p>
      <Button type="button" variant="secondary" disabled={busy} onClick={()=>void download()}><Download size={16}/>{busy?'Downloading…':'Download signup terms record'}</Button>
    </>:null}
    <Notice error={downloadError}/><span className="sr-only" role="status" aria-live="polite">{busy?'Downloading signup terms record.':''}</span>
  </section>;
}
