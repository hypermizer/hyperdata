import { request } from "node:http";
export function localDataFetch(socket, fallback = fetch) {
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== "http://local-data") {
      if (url.origin !== "https://api.hyperliquid.xyz") throw new Error("Unsupported analytics destination");
      return fallback(input, init);
    }
    if (!url.pathname.startsWith("/rest/v1/")) throw new Error("Invalid local data path");
    return new Promise((resolve,reject) => {
      const req = request({socketPath:socket,path:url.pathname.slice(8)+url.search,method:init.method??"GET",headers:init.headers},res=>{
        const chunks=[];let size=0;
        res.on("data",chunk=>{size+=chunk.length;if(size>32_000_000)req.destroy(new Error("Local response too large"));else chunks.push(chunk);});
        res.on("end",()=>resolve(new Response([204,205,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
        res.on("error",reject);
      });
      req.setTimeout(30_000,()=>req.destroy(new Error("Local data timeout")));
      req.on("error",reject);req.end(init.body);
    });
  };
}
