import {useLayoutEffect,useRef,useState} from 'react';
import {Button,Notice} from '../../components/ui';
import {readSavedSplitSuggestion,saveSplitSuggestion,clearSplitSuggestion,listSplitSuggestions,findSplitSuggestion,requestSplitSuggestion,cancelSplitSuggestion,readSplitSuggestionSource,type SavedSplitSuggestion,type SuggestionScope} from '../../lib/split-suggestions';
import type {SplitSuggestion,SplitSuggestionMime} from '../../../shared/split-suggestions';

type Props={scope:SuggestionScope;documentId:string|null;sha256:string;mimeType:SplitSuggestionMime;file:File|null;allowAutoRestore:boolean;disabled:boolean;manualChanged:boolean;appliedId?:string;onApply:(value:SplitSuggestion)=>void;onRestore:(value:SplitSuggestion,data:Awaited<ReturnType<typeof readSplitSuggestionSource>>)=>void;onJob:(value:SplitSuggestion)=>void;onRecoverAccepted:(value:SplitSuggestion)=>void};
const rangesText=(value:SplitSuggestion)=>value.ranges?.map(range=>range.start===range.end?String(range.start):`${range.start}–${range.end}`).join(', ')||'';

export default function SplitSuggestionPanel(props:Props){
 const {scope,documentId,sha256,mimeType,file,allowAutoRestore,disabled,manualChanged,appliedId}=props;
 const [binding,setBinding]=useState<SavedSplitSuggestion|null>(null),[suggestion,setSuggestion]=useState<SplitSuggestion|null>(null),[available,setAvailable]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmNew,setConfirmNew]=useState(false),[confirmApply,setConfirmApply]=useState(false),[now,setNow]=useState(Date.now());
 const committed=useRef(0),responses=useRef(0),controller=useRef(new AbortController()),running=useRef(false),callbacks=useRef(props),panel=useRef<HTMLElement>(null);
 useLayoutEffect(()=>{callbacks.current=props;});
 const matches=Boolean(binding&&(!sha256||binding.sha256===sha256)&&binding.mimeType===mimeType),expired=Boolean(suggestion&&Date.parse(suggestion.expiresAt)<=now),pending=Boolean(suggestion&&['uploading','queued','processing'].includes(suggestion.state)),canRequest=Boolean(sha256&&(documentId||file));
 useLayoutEffect(()=>{
  const version=++committed.current,turn=++responses.current;controller.current=new AbortController();const signal=controller.current.signal;let timer:ReturnType<typeof setTimeout>|undefined;const active=()=>committed.current===version&&responses.current===turn&&!signal.aborted;
  running.current=false;setBusy(false);setSuggestion(null);setAvailable(null);setError('');setConfirmNew(false);setConfirmApply(false);const saved=readSavedSplitSuggestion(scope,documentId);setBinding(saved);
  async function poll(){
   try{if(!saved)return;const result=await findSplitSuggestion(saved,active,signal);if(!active())return;setSuggestion(result);setNow(Date.now());if(result){saveSplitSuggestion({...saved,suggestionId:result.id});if(result.sourceSha256===sha256)callbacks.current.onJob(result);
    if(allowAutoRestore&&!sha256&&!documentId&&['queued','processing','ready'].includes(result.state)&&Date.parse(result.expiresAt)>Date.now()&&!result.acceptedSplitId){const data=await readSplitSuggestionSource(scope,result,active,signal);if(active())callbacks.current.onRestore(result,data);}

   }}catch(cause){if(active())setError(cause instanceof Error?cause.message:'The saved AI request could not be checked.');}
  }
  void(async()=>{try{const result=await listSplitSuggestions(scope,active,signal);if(active())setAvailable(result.available);}catch(cause){if(active())setError(cause instanceof Error?cause.message:'AI availability could not be checked.');}if(active())await poll();})();
  return()=>{committed.current++;controller.current.abort();if(timer)clearTimeout(timer);running.current=false;};
 },[scope.userId,scope.workspaceId,scope.parserId,documentId,sha256,mimeType,allowAutoRestore]);
 useLayoutEffect(()=>{if(!suggestion)return;const remaining=Date.parse(suggestion.expiresAt)-Date.now();if(remaining<=0){setNow(Date.now());return;}const timer=setTimeout(()=>setNow(Date.now()),Math.min(remaining+50,2147483647));return()=>clearTimeout(timer);},[suggestion?.id,suggestion?.expiresAt]);
 useLayoutEffect(()=>{if(error)panel.current?.scrollIntoView({block:'nearest'});},[error]);
 async function act(action:(active:()=>boolean,signal:AbortSignal)=>Promise<void>){
  if(running.current||disabled)return;const version=committed.current,turn=++responses.current,signal=controller.current.signal,active=()=>committed.current===version&&responses.current===turn&&!signal.aborted;running.current=true;setBusy(true);setError('');panel.current?.focus({preventScroll:true});
  try{await action(active,signal);}catch(cause){if(active())setError(cause instanceof Error?cause.message:'The AI request could not be completed.');}finally{if(active()){running.current=false;setBusy(false);}}
 }
 async function refresh(active:()=>boolean,signal:AbortSignal){
  const availability=await listSplitSuggestions(scope,active,signal);if(!active())return;setAvailable(availability.available);if(binding){const result=await findSplitSuggestion(binding,active,signal);if(!active())return;setSuggestion(result);setNow(Date.now());if(result&&result.sourceSha256===sha256)callbacks.current.onJob(result);}
 }
 async function start(active:()=>boolean,signal:AbortSignal,fresh=false){
  if(!canRequest)return;let saved=binding;
  if(fresh&&saved){if(suggestion&&['uploading','queued','processing'].includes(suggestion.state)&&!expired){const cancelled=await cancelSplitSuggestion(saved,suggestion.id,active,signal);if(active())callbacks.current.onJob(cancelled);}if(!active())return;clearSplitSuggestion(saved);saved=null;setSuggestion(null);}
  if(saved&&(saved.sha256!==sha256||saved.mimeType!==mimeType))throw new Error('This saved request belongs to another file. Resume it or explicitly start a new suggestion.');
  const value=saveSplitSuggestion(saved||{version:1 as const,...scope,sourceDocumentId:documentId,requestId:crypto.randomUUID(),sha256,mimeType});setBinding(value);setConfirmNew(false);
  const result=await requestSplitSuggestion(value,file,active,signal);if(!active())return;setBinding({...value,suggestionId:result.id});setSuggestion(result);setNow(Date.now());callbacks.current.onJob(result);
 }
 // Poll only a displayed durable job, using its immutable identity. No poll ever starts a provider request.
 useLayoutEffect(()=>{
  if(!suggestion||!['queued','processing'].includes(suggestion.state)||expired)return;const version=committed.current;let timer:ReturnType<typeof setTimeout>|undefined,stopped=false;const active=()=>!stopped&&version===committed.current&&!controller.current.signal.aborted;
  timer=setTimeout(()=>{if(running.current||disabled){if(active())setNow(Date.now());return;}const turn=++responses.current,current=()=>active()&&responses.current===turn;void(async()=>{try{if(!binding)return;const result=await findSplitSuggestion(binding,current,controller.current.signal);if(current()&&result){setSuggestion(result);setNow(Date.now());callbacks.current.onJob(result);}}catch(cause){if(current())setError(cause instanceof Error?cause.message:'AI status could not be checked. Retry the status check.');}})();},1800);
  return()=>{stopped=true;if(timer)clearTimeout(timer);};
 },[suggestion?.id,suggestion?.state,suggestion?.updatedAt,now,binding?.requestId,expired,disabled]);
 function apply(){if(!suggestion||!matches||expired||suggestion.state!=='ready'||suggestion.confirmedRequestId||disabled)return;if(manualChanged&&!confirmApply){setConfirmApply(true);return;}callbacks.current.onApply(suggestion);setConfirmApply(false);panel.current?.focus({preventScroll:true});}
 const working=busy||disabled;
 return <section className="split-suggestion-panel" aria-label="AI split suggestions" ref={panel} tabIndex={-1}>
  <h3>AI page ranges</h3><p className="small">Requesting suggestions sends this whole PDF or TIFF to the configured AI provider. It uses an AI request, but creates no documents or page-credit charges. Review every boundary before using it.</p>
  <Notice error={error}/>
  {available===false&&<p className="small">AI split suggestions are unavailable. You can still choose ranges manually.</p>}
  {available===null&&!error&&<p className="small" role="status">Checking AI availability…</p>}
  {!binding?<Button type="button" variant="secondary" disabled={working||!canRequest||available!==true} onClick={()=>void act((active,signal)=>start(active,signal))}>Suggest page ranges with AI</Button>:<>
   {!matches&&sha256&&<p className="small">A saved AI request belongs to a different file. Its result will not change these page ranges.</p>}
   {suggestion?.confirmedRequestId&&<><p className="small">{suggestion.acceptedSplitId?'This suggestion has already been used for a split.':'A split was already confirmed for this suggestion. Its result may still be pending.'} Resume that same request before starting another operation.</p><Button type="button" variant="secondary" disabled={working} onClick={()=>callbacks.current.onRecoverAccepted(suggestion)}>{suggestion.acceptedSplitId?'Open existing split result':'Resume confirmed split'}</Button></>}
   {!suggestion?<p className="small" role="status">A request is saved, but its result is not confirmed. Retry keeps the same request.</p>:expired&&!suggestion.acceptedSplitId?<p className="small" role="status">This suggestion expired. Its temporary source is no longer available. Start a new suggestion or choose ranges manually.</p>:suggestion.state==='uploading'?<p className="small" role="status">Source upload is not confirmed. Retry with the same file to finish this request.</p>:suggestion.state==='queued'?<p className="small" role="status">AI suggestion queued. You can close this dialog and return later.</p>:suggestion.state==='processing'?<p className="small" role="status">AI is checking page boundaries. Your manual ranges stay unchanged.</p>:suggestion.state==='failed'?<p className="small" role="status">AI could not suggest ranges for this source. Review it manually or explicitly request new suggestions.</p>:suggestion.state==='cancelled'?<p className="small" role="status">This AI request was cancelled. No documents were created by requesting suggestions.</p>:<>
    <p className="small" role="status"><strong>{suggestion.ranges?.length} suggested documents · {suggestion.pageCount} pages</strong></p><p className="small">Proposed ranges: {rangesText(suggestion)}. The draft covers every original page.</p><p className="small muted">AI boundaries can be wrong. Applying these ranges only fills the editor; Create remains a separate action.</p>
    {!suggestion.confirmedRequestId&&matches&&<>{confirmApply?<><p className="small">Replace the current manual selection with these suggested ranges?</p><div className="actions"><Button type="button" variant="secondary" disabled={working} onClick={apply}>Replace with suggested ranges</Button><Button type="button" variant="ghost" onClick={()=>setConfirmApply(false)}>Keep my ranges</Button></div></>:<Button type="button" variant="secondary" disabled={working} onClick={apply}>{appliedId===suggestion.id?'Use suggested ranges again':'Use suggested ranges'}</Button>}</>}
   </>}
   <div className="actions split-suggestion-actions">
    <Button type="button" variant="ghost" disabled={working} onClick={()=>void act(refresh)}>Check AI status</Button>
    {matches&&(!suggestion||suggestion.state==='uploading')&&!expired&&<Button type="button" variant="secondary" disabled={working||!canRequest} onClick={()=>void act((active,signal)=>start(active,signal))}>Retry saved AI request</Button>}
    {suggestion&&pending&&!expired&&<Button type="button" variant="ghost" disabled={working} onClick={()=>void act(async(active,signal)=>{const result=await cancelSplitSuggestion(binding,suggestion.id,active,signal);if(active()){setSuggestion(result);callbacks.current.onJob(result);}})}>Cancel AI request</Button>}
    {suggestion&&!documentId&&(!matches||!file)&&!expired&&['queued','processing','ready'].includes(suggestion.state)&&!suggestion.acceptedSplitId&&<Button type="button" variant="secondary" disabled={working} onClick={()=>void act(async(active,signal)=>{const data=await readSplitSuggestionSource(scope,suggestion,active,signal);if(active())callbacks.current.onRestore(suggestion,data);})}>Resume saved source</Button>}
   </div>
   {confirmNew?<div className="split-suggestion-new"><p className="small">A new suggestion uses another AI request. Any active saved suggestion will be cancelled first. Your manual ranges stay unchanged.</p><div className="actions"><Button type="button" variant="secondary" disabled={working||!canRequest||available!==true} onClick={()=>void act((active,signal)=>start(active,signal,true))}>Request new suggestions</Button><Button type="button" variant="ghost" onClick={()=>setConfirmNew(false)}>Keep saved AI request</Button></div></div>:<Button type="button" variant="ghost" disabled={working||!canRequest||available!==true} onClick={()=>setConfirmNew(true)}>Start a new AI suggestion</Button>}
  </>}
  {error&&<Button type="button" variant="ghost" disabled={working} onClick={()=>void act(refresh)}>Retry AI status check</Button>}
 </section>;
}
