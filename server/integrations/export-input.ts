import {z} from 'zod';
import {maximumExportFieldPathLength,maximumExportColumnSourceLength} from '../../shared/export-contract.js';
export const exportColumns=z.array(z.object({source:z.string().min(1).max(maximumExportColumnSourceLength),label:z.string().min(1).max(120)})).max(100);
export const exportLineItems=z.string().max(maximumExportFieldPathLength);
export const exportMappingInput=z.object({parserId:z.uuid(),name:z.string().min(1).max(100),columns:exportColumns,lineItems:exportLineItems.optional()});
