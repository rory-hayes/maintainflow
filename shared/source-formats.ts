export const sourceFormats = [
  {id:'pdf',label:'PDF',mimeType:'application/pdf'},
  {id:'png',label:'PNG',mimeType:'image/png'},
  {id:'jpeg',label:'JPEG',mimeType:'image/jpeg'},
  {id:'tiff',label:'TIFF',mimeType:'image/tiff'},
  {id:'txt',label:'Text',mimeType:'text/plain'},
  {id:'eml',label:'Email (EML)',mimeType:'message/rfc822'},
  {id:'csv',label:'CSV',mimeType:'text/csv'},
  {id:'xlsx',label:'Excel (XLSX)',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
  {id:'docx',label:'Word (DOCX)',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
  {id:'html',label:'HTML',mimeType:'text/html'},
] as const;
export type SourceFormat = typeof sourceFormats[number]['id'];

/** Field overrides are deliberately narrower than legacy parser locale settings. */
export const supportedSourceLocales = ['en-IE', 'en-GB', 'en-US', 'de-DE', 'fr-FR', 'es-ES'] as const;
export type SourceLocale = typeof supportedSourceLocales[number];
export const normalizationPolicy = 'regional-v2' as const;
export const legacyNormalizationPolicy = 'timestamp-v1' as const;
export type NormalizationPolicy = typeof normalizationPolicy | typeof legacyNormalizationPolicy;

/** Only worker admission maps a missing historical policy to legacy behavior. */
export function resolveJobNormalizationPolicy(value:unknown):NormalizationPolicy {
 if(value===undefined||value===null||value===legacyNormalizationPolicy)return legacyNormalizationPolicy;
 if(value===normalizationPolicy)return normalizationPolicy;
 throw Object.assign(new Error('This job uses an unsupported normalization version. Reprocess with current saved settings.'),{permanent:true});
}
export function fieldSourceLocale(field:{sourceLocale?:SourceLocale},locale:string|undefined,policy:NormalizationPolicy=normalizationPolicy){
 return policy===normalizationPolicy?field.sourceLocale??locale:locale;
}

/** A pre-release waiting job may receive its first schema after field overrides ship. */
interface SourceFormatField{sourceLocale?:SourceLocale;fields?:readonly SourceFormatField[];}
export function assertJobSourceFormats(schema:{fields:readonly SourceFormatField[]},policy:NormalizationPolicy){
 const hasOverride=(fields:typeof schema.fields):boolean=>fields.some(field=>field.sourceLocale!==undefined||field.fields&&hasOverride(field.fields));
 if(policy===legacyNormalizationPolicy&&hasOverride(schema.fields))throw Object.assign(new Error('This queued job predates field source formats. Reprocess with current saved settings to use this schema.'),{permanent:true});
}
