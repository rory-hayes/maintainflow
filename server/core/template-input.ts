import {z} from 'zod';
import {templateLimits} from '../../shared/template-selection.js';
export const templateBody=z.object({name:z.string().trim().min(1).max(100),matchText:z.string().max(1000).default(''),enabled:z.boolean().default(true),rules:z.array(z.object({field:z.string().max(259),anchor:z.string().min(1).max(200)}).strict()).max(templateLimits.rules)}).strict();
