// Read-only source verification during deployment. Does not import or use Feishu secrets.
import {writeFile} from 'node:fs/promises';
import {settings} from './.generated/settings.mjs';
import {collectSources,normalizeItems,loadRules} from './lib/hotspot.mjs';

const results=await collectSources(settings);
const rules=loadRules();
const report={revision:process.env.COMMIT_REF || 'local',checked_at:new Date().toISOString(),
  pending:settings.coverage.pending.map(x=>x.name),
  sources:results.map(result=>({id:result.source.id,name:result.source.name,error:result.error,
    fetched:result.items.length,matched:normalizeItems([result],rules).length,
    kind:result.source.kind || 'topic'}))};
console.log('只读来源验证：'+JSON.stringify(report));
await writeFile(new URL('public/source-status.json',import.meta.url),JSON.stringify(report)+'\n');
