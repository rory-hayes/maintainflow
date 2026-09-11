import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startWorker,setExtractionProvider} from './core/worker.js';
import {tickIntegrations} from './integrations/worker.js';

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // Importing worker helpers must not enable a provider or start queue processing.
  const {createOpenAIProvider}=await import('./core/openai-provider.js');
  setExtractionProvider(createOpenAIProvider());
  await startWorker(tickIntegrations);
}
