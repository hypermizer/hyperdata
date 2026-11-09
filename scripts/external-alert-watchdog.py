#!/usr/bin/env python3
"""Run on the independent controller; never accepts an application login."""
import json, os, pathlib, ssl, time, urllib.request
root=pathlib.Path('/etc/hyperdata-health')
config=json.loads((root/'config.json').read_text())
state_path=pathlib.Path('/var/lib/hyperdata-health/state.json')
try: previous=json.loads(state_path.read_text())
except FileNotFoundError: previous={'failures':0,'notified':False,'at':0}
ctx=ssl.create_default_context();ctx.load_cert_chain(str(root/'client.crt'),str(root/'client.key'))
healthy=False;maintenance=False
try:
 with urllib.request.urlopen(config['origin']+'/api/health',context=ctx,timeout=12) as response:
  result=json.load(response);healthy=result.get('healthy') is True;maintenance=result.get('maintenance') is True
except Exception: pass
failures=0 if healthy or maintenance else previous['failures']+1
notice=None
if failures>=2 and time.time()-previous['at']>900:
 notice='The direct Hyperdata alert server is unavailable or unhealthy. Price alerts may be delayed; check the private dashboard.'
elif healthy and previous['notified']:
 notice='The direct Hyperdata alert server has recovered.'
notified=previous['notified']
if notice:
 payload=json.dumps({'topic':config['ntfy_topic'],'title':'HYPERDATA · independent runtime check','message':notice,'priority':4 if failures else 3,'click':config['origin']+'/#/alerts'}).encode()
 request=urllib.request.Request(config['ntfy_url'],data=payload,headers={'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(request,timeout=10) as response:
  accepted=json.load(response)
 if accepted.get('event')!='message': raise RuntimeError('Watchdog notification unconfirmed')
 notified=bool(failures);previous['at']=time.time()
state_path.parent.mkdir(mode=0o700,exist_ok=True)
temporary=state_path.with_suffix('.tmp')
temporary.write_text(json.dumps({'failures':failures,'notified':notified,'at':previous['at']}));temporary.chmod(0o600);temporary.replace(state_path)
print('Hyperdata independent health: '+('maintenance' if maintenance else 'healthy' if healthy else 'unavailable'))
