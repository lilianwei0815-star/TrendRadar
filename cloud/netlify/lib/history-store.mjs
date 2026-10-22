import {getStore} from '@netlify/blobs';

// A site-wide private store survives deploys. Strong reads and conditional writes
// prevent a run that read stale history from overwriting a newer baseline.
export function createHistoryStore() {
  let store,etag,loaded=false;
  const key='last-successful-digest';
  const open=()=>store ||= getStore({name:'hotspot-delivery-production-v1',consistency:'strong',
    fetch:(input,init={})=>fetch(input,{...init,signal:AbortSignal.any([
      ...(init.signal?[init.signal]:[]),AbortSignal.timeout(7000)])})});
  return {
    async load() {
      const entry=await open().getWithMetadata(key,{type:'json',consistency:'strong'});
      etag=entry?.etag; loaded=true;
      if (entry && !etag) throw new Error('Missing history version');
      return entry?.data ?? null;
    },
    async save(snapshot) {
      if (!loaded) throw new Error('History must be read before saving');
      const result=await open().setJSON(key,snapshot,etag?{onlyIfMatch:etag}:{onlyIfNew:true});
      if (!result.modified) throw new Error('A newer history already exists');
    }
  };
}
