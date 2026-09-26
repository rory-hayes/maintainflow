/** Strict source interpretation must never borrow the host's fallback locale. */
export function regionalSourceLocale(locale:string){
 try{
  const requested=new Intl.Locale(locale);
  if(requested.numberingSystem&&requested.numberingSystem!=='latn'||requested.calendar&&requested.calendar!=='gregory')return null;
  if(!Intl.NumberFormat.supportedLocalesOf([locale],{localeMatcher:'lookup'}).length||!Intl.DateTimeFormat.supportedLocalesOf([locale],{localeMatcher:'lookup'}).length)return null;
  const numberFormat=new Intl.NumberFormat(locale),dateFormat=new Intl.DateTimeFormat(locale,{year:'numeric',month:'numeric',day:'numeric',timeZone:'UTC'});
  if(numberFormat.resolvedOptions().numberingSystem!=='latn'||dateFormat.resolvedOptions().numberingSystem!=='latn'||dateFormat.resolvedOptions().calendar!=='gregory')return null;
  const dateOrder=dateFormat.formatToParts(new Date('2026-09-17T12:00:00Z')).filter(part=>['year','month','day'].includes(part.type)).map(part=>part.type).join('-');
  return {numberFormat,dateOrder};
 }catch{return null;}
}
