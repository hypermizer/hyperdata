import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {createOwnerSession} from '../public/lib/owner-session.js';

test('server-only app has no sign-in button, public backend settings, or embedded owner credentials',async()=>{
 const [config,app,html]=await Promise.all(['config.js','app.js','index.html'].map(name=>readFile(new URL('../public/'+name,import.meta.url),'utf8')));
 assert.doesNotMatch(config,/supabaseUrl|supabasePublishableKey/);
 assert.doesNotMatch(config+'\n'+app,/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
 assert.doesNotMatch(html,/id="account-button"|Sign in|Sign out/);
 assert.doesNotMatch(app,/requestSignInLink|signOut\(/);
});
test('owner session deduplicates requests and keeps its CSRF identity shared until invalidated',async()=>{
 let calls=0;
 const identity=createOwnerSession(async(path,init)=>{calls++;assert.equal(path,'/api/owner/session');assert.equal(init.credentials,'same-origin');return Response.json({csrf:'nonce-'+calls,user:{id:'owner'}});});
 const [a,b]=await Promise.all([identity.get(),identity.get()]);assert.equal(calls,1);assert.equal(a.csrf,b.csrf);
 await identity.get();assert.equal(calls,1);identity.invalidate();assert.equal((await identity.get()).csrf,'nonce-2');
});
test('owner session fails closed when gateway authentication is missing',async()=>{
 const identity=createOwnerSession(async()=>Response.json({error:'denied'},{status:403}));
 await assert.rejects(()=>identity.get(),/gateway/);
});
