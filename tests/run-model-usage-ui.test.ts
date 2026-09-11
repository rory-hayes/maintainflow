import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import RunModelUsage from '../src/features/documents/RunModelUsage';
const render=(run:unknown)=>renderToStaticMarkup(createElement(RunModelUsage,{run}));

test('OpenAI run metadata renders recorded zero values and PostgreSQL numeric cost precisely',()=>{
  const html=render({engine:'openai',tokenUsage:{inputTokens:1234,outputTokens:0,estimatedCost:true},costUsd:'0.000123'});
  assert.match(html,/Input tokens: 1,234/);assert.match(html,/Output tokens: 0/);assert.match(html,/Estimated model cost: \$0\.000123/);
  assert.match(render({engine:'openai',tokenUsage:{estimatedCost:true},costUsd:0}),/\$0\.000000/);
});
test('Missing, invalid or unqualified run metadata never fabricates token counts or a zero cost',()=>{
  for(const run of [
    {engine:'deterministic-v2',tokenUsage:{inputTokens:1,estimatedCost:true},costUsd:1},
    {engine:'openai'},
    {engine:'openai',tokenUsage:{inputTokens:-1,outputTokens:1.5,estimatedCost:true},costUsd:' '},
    {engine:'openai',tokenUsage:{inputTokens:Infinity,outputTokens:Number.MAX_SAFE_INTEGER+1,estimatedCost:true},costUsd:'NaN'},
    {engine:'openai',tokenUsage:{estimatedCost:false},costUsd:0},
    {engine:'openai',tokenUsage:{estimatedCost:true},costUsd:-1},
  ])assert.equal(render(run),'');
});
test('Partial token metadata renders available counts without inventing absent metrics',()=>{
  const html=render({engine:'openai',tokenUsage:{outputTokens:17},costUsd:3});
  assert.match(html,/Output tokens: 17/);assert.doesNotMatch(html,/Input tokens|Estimated model cost/);
});
