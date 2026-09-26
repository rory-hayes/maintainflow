import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {signupTermsStatusSchema,type SignupPolicy,type SignupTermsAcceptance,type SignupTermsStatus} from '../../../shared/signup-terms';
import {api} from '../../lib/api';
import {Button,Notice} from '../../components/ui';

/** Consent belongs to the exact policy displayed, never merely to the signup form. */
export function currentTermsAcceptance(status:SignupTermsStatus|undefined,consent:SignupTermsAcceptance|null):SignupTermsAcceptance|undefined{
  if(!status?.enabled||!consent||consent.accepted!==true||consent.version!==status.policy.version||consent.sha256!==status.policy.sha256)return undefined;
  return {accepted:true,version:consent.version,sha256:consent.sha256};
}

export function useSignupTerms(enabled:boolean){
  const query=useQuery<unknown,Error,SignupTermsStatus>({
    queryKey:['signup-terms'],queryFn:({signal})=>api('/api/auth/signup-terms',{signal,cache:'no-store'}),
    select:value=>signupTermsStatusSchema.parse(value),enabled,retry:false,staleTime:0,refetchOnWindowFocus:true,
  });
  const [consent,setConsent]=useState<SignupTermsAcceptance|null>(null),[message,setMessage]=useState('');
  const status=query.isSuccess?query.data:undefined;
  const identity=status?.enabled?`${status.policy.version}:${status.policy.sha256}`:status?'disabled':undefined;
  const previous=useRef<string|undefined>(undefined);
  useEffect(()=>{
    setConsent(null);
    if(previous.current&&identity&&previous.current!==identity)setMessage('The signup terms changed. Please review them again.');
    if(identity)previous.current=identity;
  },[identity,enabled]);
  useEffect(()=>{if(query.isError||query.isFetching)setConsent(null);},[query.isError,query.isFetching]);
  const acceptance=currentTermsAcceptance(status,consent);
  const ready=query.isSuccess&&!query.isFetching&&Boolean(status)&&(!status!.enabled||Boolean(acceptance));
  async function reload(){setConsent(null);setMessage('');await query.refetch();}
  function choose(checked:boolean){
    setConsent(checked&&status?.enabled&&!query.isFetching?{accepted:true,version:status.policy.version,sha256:status.policy.sha256}:null);
    setMessage('');
  }
  return {query,status,acceptance,blocked:enabled&&!ready,checked:Boolean(acceptance),choose,reload,message};
}

export function TermsText({policy,summary='Read the signup terms'}:{policy:SignupPolicy;summary?:string}){
  return <details className="signup-terms-details"><summary>{summary}</summary><div className="signup-terms-document" lang={policy.language}>
    <h3>{policy.title}</h3><p className="small muted">Version {policy.version} · Language {policy.language}</p>
    <pre className="signup-terms-text">{policy.text}</pre>
    <a className="link" href={policy.url} target="_blank" rel="noopener noreferrer">Open terms page<span className="sr-only"> (opens in a new tab)</span></a>
  </div></details>;
}

export default function SignupTerms({terms,busy}:{terms:ReturnType<typeof useSignupTerms>;busy:boolean}){
  if(terms.query.isPending)return <p className="small" role="status">Checking signup terms…</p>;
  if(terms.query.isError||!terms.status)return <div className="signup-terms-status"><Notice error="We couldn’t load the signup terms. Please try again before creating your account."/><Button type="button" variant="secondary" disabled={busy||terms.query.isFetching} onClick={()=>void terms.reload()}>Retry signup terms</Button></div>;
  if(!terms.status.enabled)return null;
  const policy=terms.status.policy;
  return <section className="signup-terms" aria-label="Signup terms" aria-busy={terms.query.isFetching}>
    <TermsText policy={policy}/>
    <Notice message={terms.message}/>
    {terms.query.isFetching?<p className="small" role="status">Checking the latest signup terms…</p>:null}
    <label className="signup-terms-checkbox"><input type="checkbox" required checked={terms.checked} disabled={busy||terms.query.isFetching} onChange={event=>terms.choose(event.target.checked)}/><span lang={policy.language}>{policy.agreementText}</span></label>
  </section>;
}
