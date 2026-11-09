import sys
import unittest
from pathlib import Path
from aiohttp.test_utils import TestClient, TestServer
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'runtime'))
from tailnet_bridge import create_app, TAILNET_HOST, TAILNET_ORIGIN


class Reply:
    def __init__(self, status=204):
        self.status=status
        self.headers={'Content-Type':'application/json'}
        self.content=self
    async def __aenter__(self): return self
    async def __aexit__(self,*_): pass
    async def iter_chunked(self,_): yield b'{"ok":true}'


class PrivateBridgeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.authenticated=True
        self.forwarded=None
        app=create_app('owner@example.test')
        app.cleanup_ctx.clear()
        outer=self
        class Auth:
            def get(self,*args,**kwargs): return Reply(204 if outer.authenticated else 401)
        class Backend:
            def request(self,*args,**kwargs):
                outer.forwarded=kwargs['headers']
                return Reply(200)
        app['auth']=Auth()
        app['upstream']=Backend()
        self.client=TestClient(TestServer(app))
        await self.client.start_server()
        self.headers={'X-Forwarded-Host':TAILNET_HOST,'Tailscale-User-Login':'owner@example.test'}

    async def asyncTearDown(self): await self.client.close()

    async def test_owner_identity_and_forwarded_authority_are_required(self):
        for headers in [{},dict(self.headers,**{'Tailscale-User-Login':'another@example.test'}),dict(self.headers,**{'X-Forwarded-Host':'evil.example'})]:
            response=await self.client.get('/api/alerts',headers=headers)
            self.assertEqual(response.status,403)

    async def test_session_is_required_without_touching_terminal_logout(self):
        self.authenticated=False
        response=await self.client.get('/api/alerts',headers=self.headers)
        self.assertEqual(response.status,401)
        response=await self.client.get('/',headers=self.headers,allow_redirects=False)
        self.assertEqual(response.status,302)
        self.assertEqual(response.headers['Location'],'https://dev-mini-ohio.tail628a67.ts.net/login')

    async def test_mutations_require_the_exact_tailnet_origin(self):
        for origin in [None,'https://hypermizer.github.io']:
            headers=dict(self.headers)
            if origin:headers['Origin']=origin
            response=await self.client.post('/api/alerts',headers=headers,json={})
            self.assertEqual(response.status,403)

    async def test_trusted_bridge_strips_forged_certificate_and_authorization_headers(self):
        headers=dict(self.headers,**{'Origin':TAILNET_ORIGIN,'X-Hyperdata-Certificate':'forged','Authorization':'Bearer untrusted','Cookie':'session=test'})
        response=await self.client.post('/api/alerts',headers=headers,json={})
        self.assertEqual(response.status,200)
        self.assertFalse(any(key.lower().startswith(('tailscale-','x-hyperdata-')) or key.lower()=='authorization' for key in self.forwarded))
        self.assertEqual(self.forwarded['Origin'],TAILNET_ORIGIN)
        self.assertEqual(self.forwarded['Host'],'3.131.225.164')
        self.assertNotIn('Cookie',self.forwarded)
