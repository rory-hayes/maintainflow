export default function RunModelUsage({run}:{run:any}){
  if(run.engine!=='openai'||!run.tokenUsage||typeof run.tokenUsage!=='object')return null;
  const usage=run.tokenUsage;
  const input=Number.isSafeInteger(usage.inputTokens)&&usage.inputTokens>=0?usage.inputTokens:undefined;
  const output=Number.isSafeInteger(usage.outputTokens)&&usage.outputTokens>=0?usage.outputTokens:undefined;
  const recordedCost=typeof run.costUsd==='number'||typeof run.costUsd==='string'&&run.costUsd.trim()!==''?Number(run.costUsd):undefined;
  const cost=usage.estimatedCost===true&&recordedCost!==undefined&&Number.isFinite(recordedCost)&&recordedCost>=0?recordedCost:undefined;
  if(input===undefined&&output===undefined&&cost===undefined)return null;
  return <div>{(input!==undefined||output!==undefined)&&<p className="small" style={{fontSize:12,lineHeight:1.5}}>{input!==undefined?`Input tokens: ${input.toLocaleString('en-IE')}`:''}{input!==undefined&&output!==undefined?' · ':''}{output!==undefined?`Output tokens: ${output.toLocaleString('en-IE')}`:''}</p>}{cost!==undefined&&<p className="small" style={{fontSize:12,lineHeight:1.5}}>Estimated model cost: {new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:6,maximumFractionDigits:6}).format(cost)}</p>}</div>;
}
