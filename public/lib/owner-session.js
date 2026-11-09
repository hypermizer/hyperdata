export function createOwnerSession(fetchImpl=globalThis.fetch) {
  let current=null,pending=null,expires=0;
  return {
    async get() {
      if(current && Date.now()<expires)return current;
      if(!pending)pending=(async()=>{
        const response=await fetchImpl('/api/owner/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10_000)});
        if(!response.ok)throw new Error('Private owner session unavailable. Open Hyperdata through the gateway.');
        const result=await response.json();current=result;expires=Date.now()+50*60_000;return result;
      })().finally(()=>{pending=null;});
      return await pending;
    },
    invalidate(){current=null;expires=0;},
  };
}
export function sharedOwnerSession() {
  return globalThis.__hyperdataOwnerSession ??=createOwnerSession();
}
