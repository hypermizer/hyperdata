import https from 'node:https';
import {readFile} from 'node:fs/promises';
export async function createPrivateFetch() {
 const origin=process.env.HYPERDATA_ORIGIN??'https://3.131.225.164';
 if(origin!=='https://3.131.225.164')throw new Error('Use the dedicated certificate origin for this operator smoke check.');
 if(!process.env.HYPERDATA_CLIENT_CERT||!process.env.HYPERDATA_CLIENT_KEY)throw new Error('Set HYPERDATA_CLIENT_CERT and HYPERDATA_CLIENT_KEY to run the private smoke check.');
 const [cert,key]=await Promise.all([readFile(process.env.HYPERDATA_CLIENT_CERT),readFile(process.env.HYPERDATA_CLIENT_KEY)]);
 let csrf,pending;
 function raw(input,init={}) {
  const url=new URL(input,origin);if(url.origin!==origin)throw new Error('Private credentials cannot be forwarded to another origin.');
  return new Promise((resolve,reject)=>{
   const request=https.request(url,{method:init.method??'GET',cert,key,headers:Object.fromEntries(new Headers(init.headers)),signal:init.signal},response=>{
    const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>16_000_000)request.destroy(new Error('Private response too large'));else chunks.push(chunk);});
    response.on('end',()=>{const status=response.statusCode??502;const headers=new Headers();for(const [name,value]of Object.entries(response.headers)){if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);}resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));});
    response.on('error',reject);
   });request.on('error',reject);request.setTimeout(25000,()=>request.destroy(new Error('Private request timeout')));request.end(init.body);
  });
 }
 return async(input,init={})=>{
  const headers=new Headers(init.headers),method=init.method??'GET';
  if(!['GET','HEAD'].includes(method)){
   if(!csrf){pending??=raw('/api/owner/session').then(async response=>{if(!response.ok)throw new Error('Private authentication failed');csrf=(await response.json()).csrf;}).finally(()=>{pending=null;});await pending;}
   headers.set('origin',origin);headers.set('x-csrf-token',csrf);headers.set('cookie','__Host-hyperdata-csrf='+csrf);
  }
  return await raw(input,{...init,headers});
 };
}
