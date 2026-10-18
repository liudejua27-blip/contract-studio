import {build} from 'esbuild';
await build({entryPoints:['scripts/agent-worker.ts','scripts/agent-supervisor.ts','scripts/agent-operations.ts','scripts/backup.ts','scripts/maintenance.ts','scripts/monitor.ts','scripts/bootstrap-admin.ts','scripts/backfill-review-text.ts','scripts/setup.ts'],
  outdir:'.worker-build',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
console.info('Node worker, autoscaler and operations entrypoints built.');
