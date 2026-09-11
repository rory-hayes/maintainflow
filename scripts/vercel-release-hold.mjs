// This repository replaces a Next.js application with a stateful API and worker.
// Preserve the existing domain deployment until the isolated backend, private
// storage, HTTPS routing and provider callbacks pass hosted acceptance.
console.error('MaintainFlow document app: Vercel deployment is held. See docs/PRODUCTION-READINESS-2026-09-11.md and the deployment guide.');
// Vercel ignoreCommand uses zero to cancel a Git deployment. A manual build that
// bypasses that step also fails closed rather than publishing a frontend alone.
process.exit(process.argv.includes('--ignore') ? 0 : 1);
