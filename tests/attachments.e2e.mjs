import { createServer } from 'node:net';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
const port=await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})});
const base=`http://127.0.0.1:${port}`;
const server=Bun.spawn(['bun','run','server.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_MANAGED_ACCOUNTS:'false'},stdout:'ignore',stderr:'ignore'});
let path;
try {
  for(let i=0;i<200;i++){try{if((await fetch(`${base}/api/health`)).ok)break}catch{}await Bun.sleep(50)}
  const response=await fetch(`${base}/api/attachments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'../../report.txt',data:Buffer.from('attachment proof').toString('base64')})});
  if(!response.ok)throw new Error(`Upload failed: ${response.status}`);
  ({path}=await response.json());
  if(!path.endsWith('/report.txt')||readFileSync(path,'utf8')!=='attachment proof')throw new Error('Uploaded file incorrect');
  for(const payload of [{name:'x',data:'not base64!'}, {name:'..',data:''}, {name:'big.bin',data:Buffer.alloc(10*1024*1024+1).toString('base64')}]) {
    const invalid=await fetch(`${base}/api/attachments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    if(invalid.ok)throw new Error('Invalid attachment accepted');
  }
  const rejected=await fetch(`${base}/api/attachments`,{method:'POST',headers:{'content-type':'application/json','origin':'https://evil.example'},body:'{}'});
  if(rejected.ok)throw new Error('Cross-origin upload accepted');
} finally { if(path)rmSync(dirname(path),{recursive:true,force:true});server.kill();await server.exited }
