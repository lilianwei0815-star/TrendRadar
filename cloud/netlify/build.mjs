import {readFile, mkdir, writeFile} from 'node:fs/promises';
const root = new URL('../../', import.meta.url);
const config = JSON.parse(await readFile(new URL('config/hotspot.json', root), 'utf8'));
const rules = await readFile(new URL('config/frequency_words.txt', root), 'utf8');
await mkdir(new URL('.generated/', import.meta.url), {recursive:true});
await writeFile(new URL('.generated/settings.mjs', import.meta.url),
  `// Generated at build time from the repository's original configuration. No secrets.\nexport const settings = ${JSON.stringify(config)};\nexport const ruleText = ${JSON.stringify(rules)};\n`);
console.log(`已载入 ${config.sources.length} 个平台；北京时间每天 08:00、12:00、18:00`);
