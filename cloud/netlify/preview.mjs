import {runDigest} from './lib/hotspot.mjs';
const result = await runDigest({mode:'preview'});
console.log(JSON.stringify(result,null,2));
