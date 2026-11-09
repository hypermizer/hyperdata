// Hyperdata owner authentication is the certificate/gateway; backend tokens stay on the server.
export function serveLoginLink(_request?: Request) {
 return Response.json({error:"sign_in_retired",message:"Open Hyperdata through your private gateway."},{status:410});
}
if(import.meta.main)Deno.serve(serveLoginLink);
