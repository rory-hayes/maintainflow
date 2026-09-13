import {z} from 'zod';
import {SourceValidationError,type SourceValidationReason} from './source-validation.js';
import {sourceFormats,type SourceFormat} from '../../shared/source-formats.js';

const formatIds=sourceFormats.map(format=>format.id) as [SourceFormat,...SourceFormat[]];
export const allowedFormatsInput=z.array(z.enum(formatIds)).min(1,'Choose at least one file format.').max(sourceFormats.length)
 .refine(formats=>new Set(formats).size===formats.length,'Each file format may only be selected once.').nullable();

export function inspectedFormat(mimeType:string):SourceFormat {
 const format=sourceFormats.find(item=>item.mimeType===mimeType)?.id;
 if(!format)throw Object.assign(new Error('The inspected document format is unsupported.'),{statusCode:415});
 return format;
}

export class ParserFormatNotAllowedError extends Error {
 readonly statusCode=415;
 readonly code='parser_format_not_allowed';
 constructor(readonly parserId:string,readonly format:SourceFormat){
  super(`This parser does not accept ${sourceFormats.find(item=>item.id===format)!.label} files. Change its accepted formats or choose another parser.`);
 }
}

/** Core intake throws this only after its rejection receipt and audit commit. */
export class SourceIntakeRejectedError extends SourceValidationError {
 constructor(readonly parserId:string,reason:SourceValidationReason){super(reason);}
}
