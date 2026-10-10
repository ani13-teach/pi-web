/** Isolated real-window smoke for backup UI/startup recovery integration. No user credentials. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
const root=fileURLToPath(new URL("..",import.meta.url));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),"pi-backup-window-"));
const env={...process.env};
for(const key of Object.keys(env))if(/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|CLIENT_KEY|NPM_CONFIG_USERCONFIG|^(?:PI_|XDG_|OPENAI|ANTHROPIC|GOOGLE|GEMINI|AWS_|AZURE_|GCP_|CLOUDSDK_|VERTEX_))/i.test(key))delete env[key];
Object.assign(env,{HOME:temp,USERPROFILE:temp,APPDATA:path.join(temp,"appdata"),LOCALAPPDATA:path.join(temp,"localappdata"),PI_CODING_AGENT_DIR:path.join(temp,"agent"),PI_DESKTOP_SMOKE_USERDATA:path.join(temp,"profile"),PI_DESKTOP_SMOKE_WORKSPACE:path.join(temp,"workspace"),TEMP:path.join(temp,"tmp"),TMP:path.join(temp,"tmp")});
for(const dir of [env.APPDATA,env.LOCALAPPDATA,env.PI_CODING_AGENT_DIR,env.PI_DESKTOP_SMOKE_WORKSPACE,env.TEMP])await fs.mkdir(dir,{recursive:true});
await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR,"models.json"),JSON.stringify({providers:{fixture:{api:"openai-completions",baseUrl:"http://127.0.0.1:1/v1",apiKey:"synthetic-not-a-real-key",models:[{id:"fixture",name:"Fixture",contextWindow:128000,maxTokens:4096}]}}}));
try {
  const child=spawn(process.execPath,[path.join(root,"scripts","smoke-window.mjs"),"--project",root,"--hold","10000"],{cwd:temp,env,stdio:"inherit"});
  const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>resolve(code??1));});
  process.exitCode=Number(code);
} finally {await fs.rm(temp,{recursive:true,force:true});}
