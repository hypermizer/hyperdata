import test from 'node:test';
import assert from 'node:assert/strict';
import {createAlertRuntimeClient} from '../public/lib/alert-client.js';
test('alerts require the private origin and never send credentials through another site',async()=>{
 let called=false;
 const client=createAlertRuntimeClient({alertsRuntimeUrl:'https://192.0.2.10'},'https://hypermizer.github.io',()=>{called=true;});
 assert.equal(client.sameOrigin,false);await assert.rejects(()=>client.list(),/private server/);assert.equal(called,false);
});
test('the configured Tailscale entrance stays on its own origin for alerts',async()=>{
 const origin='https://dev-mini-ohio.tail628a67.ts.net:8446',calls=[];
 const client=createAlertRuntimeClient({alertsRuntimeUrl:'https://192.0.2.10',runtimeOrigins:['https://192.0.2.10',origin]},origin,async(path)=>{calls.push(path);return Response.json(path.endsWith('session')?{csrf:'nonce'}:{rules:[],health:[]});});
 assert.equal(client.sameOrigin,true);assert.equal(client.url,origin);await client.list();assert.deepEqual(calls,['/api/owner/session','/api/alerts']);
});
test('local API authenticates independently and attaches same-origin CSRF to mutations',async()=>{
 const calls=[];
 const client=createAlertRuntimeClient({alertsRuntimeUrl:'https://192.0.2.10'},'https://192.0.2.10',async(path,init)=>{
  calls.push({path,init});return Response.json(path.endsWith('session')?{csrf:'nonce'}:path==='/api/alerts'&&init.method==='GET'?{rules:[],health:[]}:{id:'saved'});
 });
 await client.list();await client.create({asset:'BTC',detector:'fixed_price',configuration:{direction:'above',target:100}});
 assert.equal(calls.length,3);assert.equal(calls[2].init.headers['x-csrf-token'],'nonce');
 assert.equal(calls[2].init.credentials,'same-origin');assert.equal(calls.some(c=>c.path.includes('supabase')),false);
});
