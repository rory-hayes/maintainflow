import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {SessionProvider} from '../src/lib/session';
import Onboarding from '../src/features/parsers/Onboarding';

function renderAvailability(state:'loading'|'configured'|'unconfigured'|'failed-with-stale-data',role='owner'){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  const previousFetch=globalThis.fetch;let fetchCalls=0;
  globalThis.fetch=(async()=>{fetchCalls++;throw new Error('Network calls are forbidden in this component fixture');}) as typeof fetch;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>key==='folio.workspace'?'ui-fixture':null}});
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
  const key=['ui-fixture','/api/presets'];
  client.setQueryData(['session','ui-fixture'],{user:{id:'ui-owner',name:'UI Fixture',email:'ui@example.test'},workspace:{id:'ui-fixture',name:'UI fixture',role,settings:{},plan:{name:'Fixture',monthlyPages:100,maxParsers:5,maxConcurrent:1}},workspaces:[]});
  if(state!=='loading')client.setQueryData(key,{providers:{ai:{configured:state!=='unconfigured'}}});
  if(state==='failed-with-stale-data')client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:'error',error:new Error('Synthetic status failure'),fetchStatus:'idle'});
  try{const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,null,createElement(SessionProvider,null,createElement(Onboarding)))));assert.equal(fetchCalls,0);return html;}
  finally{client.clear();globalThis.fetch=previousFetch;if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}
function aiOption(html:string){const result=html.match(/<option\b([^>]*\bvalue="ai"[^>]*)>([^<]*)<\/option>/);assert.ok(result);return {attributes:result[1],text:result[2]};}
function rulesRemainUsable(html:string){assert.match(html,/<option\b[^>]*value="rules"[^>]*selected=""/);const submit=html.match(/<button\b([^>]*)>Create parser/);assert.ok(submit);assert.doesNotMatch(submit[1],/disabled/);}

test('AI onboarding leaves rules usable while configuration is loading or unconfigured',()=>{
  for(const state of ['loading','unconfigured'] as const){
    const html=renderAvailability(state),option=aiOption(html);
    assert.match(option.attributes,/disabled=""/);
    assert.match(option.text,state==='loading'?/checking/:/not configured/);
    assert.match(html,state==='loading'?/Checking AI configuration/:/cannot read scans or images/);
    rulesRemainUsable(html);
  }
});
test('AI onboarding disables stale configured data after a status request failure',()=>{
  const html=renderAvailability('failed-with-stale-data');
  assert.match(aiOption(html).attributes,/disabled=""/);
  assert.match(aiOption(html).text,/status unavailable/);
  assert.match(html,/AI configuration could not be checked/);
  rulesRemainUsable(html);
});
test('AI onboarding enables AI only for configured status and retains the review disclosure',()=>{
  const html=renderAvailability('configured');
  assert.doesNotMatch(aiOption(html).attributes,/disabled/);
  assert.equal(aiOption(html).text,'AI extraction');
  assert.match(html,/AI is configured/);assert.match(html,/then review the results/);
  rulesRemainUsable(html);
});
test('Read-only workspace users cannot access the parser creation form',()=>{
  const html=renderAvailability('configured','viewer');
  assert.match(html,/Parser creation needs editor access/);
  assert.doesNotMatch(html,/<form|<option[^>]*value="ai"|>Create parser</);
});
