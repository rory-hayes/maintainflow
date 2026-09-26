import {regionalSourceLocale} from './source-locale.js';
const currencies=new Set(Intl.supportedValuesOf('currency'));
const horizontalSpace=/^[ \u00a0\u202f]+|[ \u00a0\u202f]+$/g;
const trim=(value:string)=>value.replace(horizontalSpace,'');

/** Regional source tokens only. Canonical numeric defaults/corrections bypass this parser. */
export function normalizeSourceNumber(value:unknown,kind:'number'|'currency',locale:string):unknown {
 if(typeof value==='number')return value;
 if(typeof value!=='string'||value.length>65_536)return value;
 let token=value.trim();
 if(!token||/[\r\n\t]/.test(token))return value;
 let decimal:string,group:string,primary:number,secondary:number;
 try{
  const regional=regionalSourceLocale(locale);if(!regional)return value;
  const format=regional.numberFormat;
  const parts=format.formatToParts(1234567890123.5),integers=parts.filter(part=>part.type==='integer');
  decimal=parts.find(part=>part.type==='decimal')?.value??'.';group=parts.find(part=>part.type==='group')?.value??',';
  primary=integers.at(-1)!.value.length;secondary=integers.at(-2)?.value.length??primary;
 }catch{return value;}
 const parenthesized=token.startsWith('(')&&token.endsWith(')');
 if(parenthesized)token=trim(token.slice(1,-1));
 if(/[()]/.test(token))return value;
 let sign=1,signed=false;
 const takeSign=()=>{
  if(!/^[+-]/.test(token))return true;
  if(signed||parenthesized)return false;
  signed=true;sign=token[0]==='-'?-1:1;token=trim(token.slice(1));return true;
 };
 if(!takeSign())return value;
 if(kind==='currency'){
  const prefix=token.match(/^(?:[A-Z]{3}|\p{Sc})/u)?.[0];
  if(prefix){if(prefix.length===3&&!currencies.has(prefix))return value;token=trim(token.slice(prefix.length));if(!takeSign())return value;}
  const suffix=token.match(/(?:[A-Z]{3}|\p{Sc})$/u)?.[0];
  if(suffix){if(prefix||suffix.length===3&&!currencies.has(suffix))return value;token=trim(token.slice(0,-suffix.length));}
 }
 // Decimal punctuation occurs once at most and is never silently repaired.
 const decimalParts=token.split(decimal);if(decimalParts.length>2)return value;
 let integer=decimalParts[0];const fraction=decimalParts[1];
 if(fraction!==undefined&&!/^\d+$/.test(fraction))return value;
 if(!integer&&fraction===undefined)return value;
 if(/[ \u00a0\u202f]/.test(group)){
  // French grouping admits each common horizontal-space representation, but
  // mixing them within a token is not a reason to guess which separators to drop.
  const used=[...new Set(integer.match(/[ \u00a0\u202f]/g)??[])];if(used.length>1)return value;
  if(used.length)integer=integer.split(used[0]).join(group);
 }
 const groups=integer.split(group);
 if(groups.length>1){
  if(!groups.every(part=>/^\d+$/.test(part))||groups.at(-1)!.length!==primary||groups[0].length<1||groups[0].length>secondary||groups.slice(1,-1).some(part=>part.length!==secondary))return value;
 }else if(integer&&!/^\d+$/.test(integer))return value;
 if(!integer&&!fraction)return value;
 const parsed=Number(`${groups.join('')||'0'}${fraction===undefined?'':'.'+fraction}`)*(parenthesized?-1:sign);
 return Number.isFinite(parsed)?parsed:value;
}
