/** Reproducible local validation: synthetic profile, no credentials, serial suites.
 * SDK project-trust walks all ancestors (not only to HOME), so on Windows use
 * an owned directory outside the real user home, not AppData/Local/Temp.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {ensurePrivateDirectory} from "../lib/backup/transaction.ts";
const root=fileURLToPath(new URL("..",import.meta.url));
const selection=process.argv[2]??"all";
if(!["all","web","desktop","backup"].includes(selection))throw new Error("Expected all, web, desktop or backup");
let base=os.tmpdir();
const home=await fs.realpath(os.homedir());
const inside=(parent,child)=>{const relative=path.relative(parent,child);return relative===""||relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative);};
if(process.platform==="win32"&&inside(home,await fs.realpath(base))){
  base=await fs.realpath(path.join(process.env.PUBLIC??path.join(path.dirname(home),"Public"),"Documents"));
  if(inside(home,base))throw new Error("Cannot isolate SDK ancestor discovery outside the user home");
}
const temp=await fs.mkdtemp(path.join(base,"pi-desktop-tests-"));
const env={...process.env};
for(const key of Object.keys(env))if(/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|CLIENT_KEY|NPM_CONFIG_USERCONFIG|^(?:PI_|XDG_|OPENAI|ANTHROPIC|GOOGLE|GEMINI|AWS_|AZURE_|GCP_|CLOUDSDK_|VERTEX_)/i.test(key))delete env[key];
Object.assign(env,{HOME:temp,USERPROFILE:temp,APPDATA:path.join(temp,"appdata"),LOCALAPPDATA:path.join(temp,"localappdata"),PI_CODING_AGENT_DIR:path.join(temp,"agent"),TEMP:path.join(temp,"tmp"),TMP:path.join(temp,"tmp")});
let failed=false;
try {
  await ensurePrivateDirectory(temp);
  for(const dir of [env.APPDATA,env.LOCALAPPDATA,env.PI_CODING_AGENT_DIR,env.TEMP])await fs.mkdir(dir,{recursive:true});
  const pkg=JSON.parse(await fs.readFile(path.join(root,"package.json"),"utf8"));
  for(const suite of selection==="all"?["web","desktop","backup"]:[selection]){
    const args=suite==="web"?["scripts/run-web-tests.mjs","--serial","--tap"]:pkg.scripts["test:"+suite].split(" ").slice(1);
    if(suite!=="web")args.splice(args.indexOf("--test")+1,0,"--test-concurrency=1","--test-reporter=tap");
    console.log("\n=== Isolated "+suite+" suite ===");
    const child=spawn(process.execPath,args,{cwd:root,env,stdio:"inherit"});
    const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code??1));});
    console.log("=== "+suite+" exit "+code+" ===");
    if(code!==0)failed=true;
  }
  process.exitCode=failed?1:0;
} finally {await fs.rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
