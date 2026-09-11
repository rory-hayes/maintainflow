import type {FastifyInstance} from 'fastify';
import {registerAuth} from './auth-routes.js';
import {registerParsers} from './parser-routes.js';
import {registerDocuments} from './document-routes.js';
import {registerWorkspace} from './workspace-routes.js';
import {registerNotifications} from './notifications.js';
export async function registerCore(app:FastifyInstance){await registerAuth(app);await registerParsers(app);await registerDocuments(app);await registerWorkspace(app);await registerNotifications(app);}
export {requireActor,editors,admins,requireSession} from './auth.js';
export {withWorkspace,adminPool,appPool,camel,badRequest,notFound,audit} from './db.js';
export {resolveRun,publicRun} from './runs.js';
export {addDocument} from './intake.js';
