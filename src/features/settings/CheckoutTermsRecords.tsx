import {useLayoutEffect,useRef,useState} from 'react';
import {useInfiniteQuery} from '@tanstack/react-query';
import {Download} from 'lucide-react';
import type {CheckoutTermsList,CheckoutTermsSummary} from '../../../shared/checkout-contracts';
import {Button,Notice,dateTime} from '../../components/ui';
import {api,workspaceId} from '../../lib/api';

function acceptanceLabel(record:CheckoutTermsSummary){
  return record.completion?.state==='accepted'?'Terms accepted':record.completion?'Acceptance not recorded':'Awaiting acceptance record';
}

export default function CheckoutTermsRecords({workspace}:{workspace:string}){
  const query=useInfiniteQuery({
    queryKey:[workspace,'checkout-terms-records'],
    initialPageParam:null as string|null,
    queryFn:({pageParam,signal})=>api<CheckoutTermsList>(`/api/billing/contracts${pageParam?`?cursor=${encodeURIComponent(pageParam)}`:''}`,{signal}),
    getNextPageParam:page=>page.nextCursor??undefined,
    retry:false,
  });
  const [downloading,setDownloading]=useState<string|null>(null),[downloadError,setDownloadError]=useState('');
  const downloadController=useRef<AbortController|null>(null);
  useLayoutEffect(()=>()=>{downloadController.current?.abort();downloadController.current=null;},[]);
  async function download(record:CheckoutTermsSummary){
    if(downloadController.current)return;
    const controller=new AbortController();downloadController.current=controller;
    const selectedWorkspace=workspaceId(),current=()=>downloadController.current===controller&&!controller.signal.aborted&&workspaceId()===selectedWorkspace;
    setDownloading(record.id);setDownloadError('');
    try{
      const response=await fetch(`/api/billing/contracts/${encodeURIComponent(record.id)}/download`,{signal:controller.signal,headers:{'X-Workspace-Id':workspace},credentials:'same-origin',cache:'no-store',redirect:'error'});
      if(!response.ok||(response.headers.get('content-type')||'').split(';')[0].trim()!=='text/plain')throw new Error('The terms record could not be downloaded. Please try again.');
      const blob=await response.blob();if(!current())return;
      const href=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=href;anchor.download=`checkout-terms-${record.id}.txt`;anchor.click();setTimeout(()=>URL.revokeObjectURL(href),5000);
    }catch(error){if(current())setDownloadError(error instanceof Error?error.message:'The terms record could not be downloaded. Please try again.');}
    finally{if(current()){downloadController.current=null;setDownloading(null);}}
  }
  const first=query.data?.pages[0],records=query.data?.pages.flatMap(page=>page.records)||[];
  if(query.isPending||first&&!first.captureEnabled&&!records.length&&!first.legacyCheckout)return null;
  return <section className="settings-subsection checkout-terms" aria-labelledby="checkout-terms-heading">
    <h2 id="checkout-terms-heading">Checkout terms records</h2>
    <p className="small muted">Download the terms saved for this workspace’s Checkouts. Terms acceptance does not confirm payment or a subscription change.</p>
    {query.error?<div className="checkout-terms-error"><Notice error="Checkout terms records could not be loaded."/><Button variant="secondary" disabled={query.isFetching} onClick={()=>void (query.isFetchNextPageError?query.fetchNextPage():query.refetch())}>Try again</Button></div>:null}
    {first&&!records.length&&!first.legacyCheckout?<p className="small">No Checkout terms records yet.</p>:null}
    {first?.legacyCheckout?<div className="settings-callout"><strong>Earlier {first.legacyCheckout.mode==='test'?'test ':''}Checkout · acceptance unknown</strong><p>No terms acceptance record is available for this earlier Checkout.</p></div>:null}
    {records.length?<ul className="checkout-terms-list">{records.map(record=><li className="checkout-terms-row" key={record.id}>
      <div><h3>{record.planId==='team'?'Team':'Standard'} · {record.mode==='test'?'Test Checkout':'Live Checkout'}</h3><p className="checkout-terms-state">{acceptanceLabel(record)}</p><p className="small muted">Saved <time dateTime={record.createdAt}>{dateTime(record.createdAt)}</time> · Terms version {record.policyVersion}</p>{record.completion?.state==='accepted'?<p className="small muted">Acceptance recorded <time dateTime={record.completion.observedAt}>{dateTime(record.completion.observedAt)}</time></p>:null}</div>
      <Button variant="secondary" disabled={Boolean(downloading)} aria-label={`Download ${record.planId==='team'?'Team':'Standard'} terms saved ${dateTime(record.createdAt)}`} onClick={()=>void download(record)}><Download size={16}/>{downloading===record.id?'Downloading…':'Download terms'}</Button>
    </li>)}</ul>:null}
    <Notice error={downloadError}/>
    {query.hasNextPage&&!query.isFetchNextPageError?<Button variant="secondary" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>{query.isFetchingNextPage?'Loading…':'Show older records'}</Button>:null}
    <span className="sr-only" role="status" aria-live="polite">{downloading?'Downloading terms record.':''}</span>
  </section>;
}
