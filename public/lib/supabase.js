import { createClient } from "../vendor/supabase.js?v=2.52.1-owner";
import {sharedOwnerSession} from './owner-session.js?v=20261109-owner';

export function createWatchlistClient(config) {
  if(!config.runtimeOrigins?.includes(globalThis.location?.origin)) return null;
  const key = "__hyperdataSupabaseClient";
  if (!globalThis[key]) {
    const identity=sharedOwnerSession();
    const client=createClient(globalThis.location.origin+'/api/owner','private-owner',{
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
      global:{fetch:async(input,init={})=>{
        const target=new URL(input instanceof Request?input.url:input);
        if(target.origin!==globalThis.location.origin || !target.pathname.startsWith('/api/owner/'))throw new Error('Owner requests must remain inside private Hyperdata.');
        const session=await identity.get();
        const headers=new Headers(init.headers);
        if(!['GET','HEAD'].includes(init.method??'GET'))headers.set('x-csrf-token',session.csrf);
        const response=await fetch(input,{...init,headers,credentials:'same-origin',cache:'no-store',signal:init.signal??AbortSignal.timeout(25_000)});
        if(response.status===403)identity.invalidate();
        return response;
      }},
    });
    const getSession=async()=>{
      try{const result=await identity.get();return {data:{session:{user:result.user}},error:null};}
      catch(error){return {data:{session:null},error};}
    };
    client.auth.getSession=getSession;
    client.auth.onAuthStateChange=()=>({data:{subscription:{unsubscribe(){}}}});
    globalThis[key]=client;
  }
  return globalThis[key];
}
