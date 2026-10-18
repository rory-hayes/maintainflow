import test from 'node:test';
import assert from 'node:assert/strict';
import {Children,createElement,isValidElement,type ComponentProps,type ButtonHTMLAttributes} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import ReprocessConfirmation,{createReprocessRequest} from '../src/features/documents/ReprocessConfirmation';
import {Modal} from '../src/components/ui';
import {useAction} from '../src/lib/api';

const documentId='00000000-0000-4000-8000-000000000017';
async function withAction(work:(context:{action:ReturnType<typeof useAction>;client:QueryClient;calls:RequestInit[]})=>Promise<void>,response:()=>Promise<Response>=async()=>Response.json({job:{id:'owned-new-job'}})){
  const fetch=globalThis.fetch,storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  const calls:RequestInit[]=[];
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=> 'owned-synthetic-workspace'}});
  globalThis.fetch=(async(input,init)=>{
    assert.equal(String(input),`/api/documents/${documentId}/reprocess`);
    assert.equal(init?.method,'POST');assert.equal(init.body,'{}');
    assert.equal(new Headers(init.headers).get('X-Workspace-Id'),'owned-synthetic-workspace');
    calls.push(init);return response();
  }) as typeof fetch;
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  client.setQueryData(['owned-synthetic-workspace','document'],{id:documentId});
  let action!:ReturnType<typeof useAction>;
  function Probe(){action=useAction();return null;}
  try{
    renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(Probe)));
    await work({action,client,calls});
  }finally{
    client.clear();globalThis.fetch=fetch;
    if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');
  }
}
function dialog({pages=1,busy=false,cancel=()=>{},confirm=()=>{},invoker=null,fallback=null}:{pages?:number;busy?:boolean;cancel?:()=>void;confirm?:()=>void;invoker?:HTMLButtonElement|null;fallback?:HTMLElement|null}={}){
  const element=ReprocessConfirmation({open:true,pageCount:pages,busy,onCancel:cancel,onConfirm:confirm,returnFocusRef:{current:invoker},fallbackFocusRef:{current:fallback}});
  assert.equal(element.type,Modal);
  return element.props as ComponentProps<typeof Modal>;
}
function buttons(props:ComponentProps<typeof Modal>){
  const actions=Children.toArray(props.children).find(child=>isValidElement(child)&&child.type==='div');
  assert.ok(isValidElement<{children:React.ReactNode}>(actions));
  return Children.toArray(actions.props.children).map(child=>{
    assert.ok(isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(child));return child.props;
  });
}

test('opening and cancelling generic reprocess sends no request, including a stale confirm callback',async()=>{
  await withAction(async({action,calls})=>{
    const request=createReprocessRequest(documentId,3,action.run);let closed=0;
    const props=dialog({pages:3,cancel:()=>{if(request.cancel())closed++;}});
    assert.equal(calls.length,0);
    (buttons(props)[0].onClick as ()=>void)();
    assert.equal(closed,1);assert.equal(await request.confirm(),false);assert.equal(calls.length,0);
    // Escape and the shared dialog's Close control also use this cancellation path.
    props.onOpenChange(false);assert.equal(calls.length,0);
  });
});

test('a confirmed reprocess sends one scoped POST while pending double clicks and close are blocked',async()=>{
  let finish!:(response:Response)=>void;
  const pending=new Promise<Response>(resolve=>{finish=resolve;});
  await withAction(async({action,client,calls})=>{
    const request=createReprocessRequest(documentId,2,action.run);
    const first=request.confirm();
    assert.equal(calls.length,1);assert.equal(request.cancel(),false);
    assert.equal(await request.confirm(),false);assert.equal(calls.length,1);
    finish(Response.json({job:{id:'owned-new-job'}}));
    assert.equal(await first,true);assert.equal(await request.confirm(),false);
    assert.equal(calls.length,1);
    assert.equal(client.getQueryState(['owned-synthetic-workspace','document'])?.isInvalidated,true);
  },()=>pending);
});

test('a failed confirmed request cannot be replayed from the same confirmation',async()=>{
  await withAction(async({action,calls})=>{
    const request=createReprocessRequest(documentId,1,action.run);
    assert.equal(await request.confirm(),true);
    assert.equal(await request.confirm(),false);assert.equal(calls.length,1);
  },async()=>Response.json({message:'The request could not be completed.'},{status:503}));
});

test('confirmation supplies a named shared dialog, exact page-credit disclosure and pending controls',()=>{
  for(const pages of [1,3]){
    const props=dialog({pages});
    assert.equal(props.title,'Reprocess this document?');
    assert.match(props.description!,new RegExp(`This uses ${pages} additional page credit${pages===1?'':'s'}`));
    assert.match(props.description!,/current saved settings/);
    assert.match(props.description!,/Existing results and approved output remain available/);
    assert.match(props.description!,/Cancel uses no page credits/);
    const html=renderToStaticMarkup(createElement('div',null,props.children));
    assert.match(html,/>Cancel<\/button>/);assert.match(html,new RegExp(`Reprocess · ${pages} page${pages===1?'':'s'}`));
  }
  const pending=dialog({busy:true});
  assert.ok(buttons(pending).every(button=>button.disabled));
  const html=renderToStaticMarkup(createElement('div',null,pending.children));
  assert.match(html,/Queuing…/);assert.match(html,/role="status" aria-live="polite" aria-atomic="true"/);
});

test('confirmation restores its enabled invoker or the review heading after it becomes queued',()=>{
  for(const [isConnected,disabled,expected] of [[true,false,1],[false,false,0],[true,true,0]] as const){
    let focused=0,fallbackFocused=0,prevented=0;
    const invoker={isConnected,disabled,focus(options:FocusOptions){assert.deepEqual(options,{preventScroll:true});focused++;}} as HTMLButtonElement;
    const fallback={isConnected:true,focus(options:FocusOptions){assert.deepEqual(options,{preventScroll:true});fallbackFocused++;}} as HTMLHeadingElement;
    dialog({invoker,fallback}).onCloseAutoFocus!({preventDefault(){prevented++;}} as Event);
    assert.equal(prevented,1);assert.equal(focused,expected);assert.equal(fallbackFocused,1-expected);
  }
  let prevented=0;
  dialog({fallback:{isConnected:false} as HTMLHeadingElement}).onCloseAutoFocus!({preventDefault(){prevented++;}} as Event);
  assert.equal(prevented,0,'A detached review must not suppress the shared dialog fallback');
});

test('an unknown or invalid page count cannot open a chargeable reprocess request',()=>{
  for(const pages of [0,-1,1.5,NaN,Infinity])assert.throws(()=>createReprocessRequest(documentId,pages,async()=>{throw new Error('Must not submit');}),/page count is unavailable/);
});
