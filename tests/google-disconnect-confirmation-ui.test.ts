import test from 'node:test';
import assert from 'node:assert/strict';
import {Children,createElement,isValidElement,type ComponentProps,type ButtonHTMLAttributes} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import GoogleDisconnectConfirmation,{createGoogleDisconnectRequest,googleDisconnectMessage,type GoogleDisconnectResult} from '../src/features/integrations/GoogleDisconnectConfirmation';
import {Modal} from '../src/components/ui';
import {useAction} from '../src/lib/api';

const integration={id:'00000000-0000-4000-8000-000000000017',name:'Owned QA Sheet'};
const confirmed:GoogleDisconnectResult={disconnected:true,providerRevoked:true,reason:null};
async function withAction(work:(context:{action:ReturnType<typeof useAction>;client:QueryClient;calls:RequestInit[];select:(workspace:string)=>void})=>Promise<void>,response:()=>Promise<Response>=async()=>Response.json(confirmed)){
  const fetch=globalThis.fetch,storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  const calls:RequestInit[]=[];let workspace='owned-primary';
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>workspace}});
  globalThis.fetch=(async(input,init)=>{
    assert.equal(String(input),`/api/google/${integration.id}/disconnect`);
    assert.equal(init?.method,'POST');assert.equal(init.body,'{}');
    assert.equal(new Headers(init.headers).get('X-Workspace-Id'),'owned-primary');
    calls.push(init);return response();
  }) as typeof fetch;
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
  client.setQueryData(['owned-primary','/api/integrations'],{integrations:[integration]});
  let action!:ReturnType<typeof useAction>;
  function Probe(){action=useAction();return null;}
  try{renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(Probe)));await work({action,client,calls,select:value=>{workspace=value;}});}
  finally{client.clear();globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}
function dialog({busy=false,cancel=()=>{},confirm=()=>{},invoker=null,fallback=null}:{busy?:boolean;cancel?:()=>void;confirm?:()=>void;invoker?:HTMLButtonElement|null;fallback?:HTMLElement|null}={}){
  const element=GoogleDisconnectConfirmation({open:true,name:integration.name,busy,onCancel:cancel,onConfirm:confirm,returnFocusRef:{current:invoker},fallbackFocusRef:{current:fallback}});
  assert.equal(element.type,Modal);return element.props as ComponentProps<typeof Modal>;
}
function buttons(props:ComponentProps<typeof Modal>){
  const actions=Children.toArray(props.children).find(child=>isValidElement(child)&&child.type==='div');
  assert.ok(isValidElement<{children:React.ReactNode}>(actions));
  return Children.toArray(actions.props.children).map(child=>{assert.ok(isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(child));return child.props;});
}

test('Google disconnect Cancel and shared-dialog dismissal send nothing and invalidate stale confirm callbacks',async()=>{
  for(const close of ['cancel','dialog'] as const)await withAction(async({action,calls})=>{
    const request=createGoogleDisconnectRequest(integration,action.run,()=>assert.fail('No result before confirmation'));let closed=0;
    const props=dialog({cancel:()=>{if(request.cancel())closed++;}});
    assert.equal(calls.length,0);
    if(close==='cancel')(buttons(props)[0].onClick as ()=>void)();else props.onOpenChange(false);
    assert.equal(closed,1);assert.equal(await request.confirm(),false);assert.equal(calls.length,0);
    // Radix routes Escape, Close and outside dismissal through onOpenChange(false).
    // Actual browser Escape/focus behavior is verified separately, not by SSR.
  });
});

test('Google disconnect confirms once, blocks pending dismissal and preserves the selected workspace',async()=>{
  let finish!:(response:Response)=>void;const pending=new Promise<Response>(resolve=>{finish=resolve;});
  await withAction(async({action,client,calls,select})=>{
    const results:GoogleDisconnectResult[]=[];
    const request=createGoogleDisconnectRequest(integration,action.run,result=>results.push(result));
    const first=request.confirm();select('owned-control');
    assert.equal(calls.length,1);assert.equal(request.cancel(),false);assert.equal(await request.confirm(),false);
    finish(Response.json(confirmed));assert.equal(await first,true);assert.equal(await request.confirm(),false);
    assert.deepEqual(results,[confirmed]);assert.equal(calls.length,1);
    assert.equal(client.getQueryState(['owned-primary','/api/integrations'])?.isInvalidated,true);
  },()=>pending);
});

test('Google disconnect refuses an empty or changed confirmation workspace without a POST',async()=>{
  for(const binding of ['empty','changed'] as const)await withAction(async({action,calls,select})=>{
    if(binding==='empty')select('');
    const errors:string[]=[];let outcomes=0;
    const run:typeof action.run=(work,success)=>action.run(async()=>{try{return await work();}catch(error){errors.push((error as Error).message);throw error;}},success);
    const request=createGoogleDisconnectRequest(integration,run,()=>{outcomes++;});
    if(binding==='changed')select('owned-control');
    assert.equal(await request.confirm(),true);assert.equal(calls.length,0);assert.equal(outcomes,0);assert.equal(errors.length,1);
    assert.match(errors[0],binding==='empty'?/Select a workspace/:/workspace changed/);
    select('owned-primary');assert.equal(await request.confirm(),false);assert.equal(calls.length,0);
  });
});

test('Google disconnect communicates actual confirmed versus unconfirmed revocation outcomes',async()=>{
  for(const providerRevoked of [true,false]){
    const response:GoogleDisconnectResult={disconnected:true,providerRevoked,reason:providerRevoked?null:'Local delivery is disabled.'};
    await withAction(async({action,calls})=>{
      const messages:string[]=[];const request=createGoogleDisconnectRequest(integration,action.run,result=>messages.push(googleDisconnectMessage(result)));
      assert.equal(await request.confirm(),true);assert.equal(calls.length,1);assert.equal(messages.length,1);
      if(providerRevoked){assert.match(messages[0],/Google confirmed the revocation request/);assert.match(messages[0],/Other connections.*may need to reconnect/);}
      else{assert.match(messages[0],/disconnected locally/);assert.match(messages[0],/revocation could not be confirmed/);assert.match(messages[0],/Google account/);assert.doesNotMatch(messages[0],/Google confirmed/);}
    },async()=>Response.json(response));
  }
});

test('Google disconnect HTTP failure produces no revocation-success outcome or automatic repeat',async()=>{
  await withAction(async({action,calls})=>{
    let outcomes=0;const request=createGoogleDisconnectRequest(integration,action.run,()=>{outcomes++;});
    assert.equal(await request.confirm(),true);assert.equal(await request.confirm(),false);assert.equal(outcomes,0);assert.equal(calls.length,1);
  },async()=>Response.json({message:'The request could not be completed.'},{status:503}));
});

test('Google disconnect confirmation explains account-wide effects and external data, with pending controls',()=>{
  const props=dialog();assert.equal(props.title,'Disconnect “Owned QA Sheet”?');
  assert.match(props.description!,/other MaintainFlow connections using the same Google account/);
  assert.match(props.description!,/other workspaces/);assert.match(props.description!,/reconnect/);
  const html=renderToStaticMarkup(createElement('div',null,props.children));
  assert.match(html,/Existing spreadsheet data remains/);assert.match(html,/Writes already submitted may finish/);
  assert.match(html,/>Cancel<\/button>/);assert.match(html,/Disconnect and revoke Google access/);
  const pending=dialog({busy:true});assert.ok(buttons(pending).every(button=>button.disabled));
  assert.match(renderToStaticMarkup(createElement('div',null,pending.children)),/role="status" aria-live="polite" aria-atomic="true"/);
});

test('Google disconnect restores invoker focus or the connections heading after its button disappears',()=>{
  for(const available of [true,false]){
    let invokerFocus=0,headingFocus=0,prevented=0;
    const invoker={isConnected:available,disabled:false,focus(options:FocusOptions){assert.deepEqual(options,{preventScroll:true});invokerFocus++;}} as HTMLButtonElement;
    const fallback={isConnected:true,focus(options:FocusOptions){assert.deepEqual(options,{preventScroll:true});headingFocus++;}} as HTMLHeadingElement;
    dialog({invoker,fallback}).onCloseAutoFocus!({preventDefault(){prevented++;}} as Event);
    assert.equal(prevented,1);assert.equal(invokerFocus,available?1:0);assert.equal(headingFocus,available?0:1);
  }
});
