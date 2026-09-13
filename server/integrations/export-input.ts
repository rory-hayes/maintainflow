import {z} from 'zod';
export const exportColumns=z.array(z.object({source:z.string().min(1).max(120),label:z.string().min(1).max(120)})).max(100);
export const exportMappingInput=z.object({parserId:z.uuid(),name:z.string().min(1).max(100),columns:exportColumns,lineItems:z.string().max(100).optional()});
