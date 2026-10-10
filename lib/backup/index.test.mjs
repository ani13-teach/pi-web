import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackup, inspectBackup, restoreBackup, scanBackup, planRestore } from "./index.ts";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),"pi-complete-backup-"));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const agentDir=path.join(home,"source"),homeDir=path.join(home,"home"),target=path.join(home,"target"),projectDir=path.join(home,"project");
  await Promise.all([agentDir,homeDir,target,projectDir].map(p=>fs.mkdir(p)));
  async function put(rel,text){const p=path.join(agentDir,rel);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,text);}
  return {home,agentDir,homeDir,target,projectDir,put,password:"fixture-password",outputPath:path.join(home,"full.pibak")};
}
const choices = info => info.manifest.resources.map(r=>({resourceId:r.id,conflict:"replace",activation:"enable"}));
test("complete scan covers credentials, tool scripts/assets, overrides, memory and all saved sessions; excludes business/app/cache",async t=>{
  const f=await fixture(t);
  for(const [p,s]of Object.entries({"settings.json":'{"theme":"dark","apiKey":"SECRET"}',"auth.json":'{"other":{"key":"SECRET"}}',"subagents.json":'{"agents":[]}',"desktop-agents/custom.md":"custom","desktop-agents/.deleted/706c616e":"", "skills/example/SKILL.md":"skill", "skills/example/assets/data.db":"necessary asset", "skills/example/scripts/do.py":"tool code", "agent-memory/work/notes.md":"remember", "workflows/helper.js":"workflow", "sessions/work/s.jsonl":'{"type":"session","cwd":"old"}\n', "logs/run.log":"DO-NOT-BACKUP", "cache/tmp.db":"DO-NOT-BACKUP"}))await f.put(p,s);
  await fs.mkdir(path.join(f.projectDir,".pi"));await fs.writeFile(path.join(f.projectDir,".pi","subagents.json"),"{}");await fs.writeFile(path.join(f.projectDir,"main.ts"),"BUSINESS-SOURCE");
  const o={...f,projectDirs:[f.projectDir]};const scan=await scanBackup(o);assert.equal(scan.blockers.length,0);assert.ok(scan.resources.some(r=>r.kind==="memory"));
  await createBackup(o);const info=await inspectBackup({archivePath:f.outputPath,password:f.password});
  for(const part of ["auth.json","subagents.json",".deleted/706c616e","assets/data.db","scripts/do.py","notes.md","helper.js","s.jsonl"])assert.ok(info.manifest.entries.some(e=>e.relativePath.endsWith(part)),part);
  assert.ok(!info.manifest.entries.some(e=>/main.ts|logs\/|cache\//.test(e.relativePath)));
  const bytes=await fs.readFile(f.outputPath);for(const s of ["SECRET","remember","tool code","BUSINESS-SOURCE"])assert.ok(!bytes.includes(Buffer.from(s)));
});
test("source fingerprint binds same-size changes and archive destination is never overwritten",async t=>{
  const f=await fixture(t);await f.put("settings.json",'{"theme":"dark"}');const scan=await scanBackup(f);await f.put("settings.json",'{"theme":"pine"}');
  await assert.rejects(createBackup({...f,expectedFingerprint:scan.fingerprint}),/changed/);
  await createBackup(f);const before=await fs.readFile(f.outputPath);await assert.rejects(createBackup(f),/exists/);assert.deepEqual(await fs.readFile(f.outputPath),before);
});
test("wrong password and corrupt archive never modify effective data",async t=>{
  const f=await fixture(t);await f.put("auth.json",'{"key":"SECRET"}');await createBackup(f);
  await assert.rejects(inspectBackup({archivePath:f.outputPath,password:""}),/password/i);
  await assert.rejects(inspectBackup({archivePath:f.outputPath,password:"wrong"}),/Invalid backup/);
  const bytes=await fs.readFile(f.outputPath);bytes[bytes.length-20]^=1;await fs.writeFile(f.outputPath,bytes);
  await assert.rejects(restoreBackup({agentDir:f.target,homeDir:f.homeDir,archivePath:f.outputPath,password:f.password,decisions:[],configurationConsent:true}),/Invalid backup/);
  assert.deepEqual(await fs.readdir(f.target),[]);
});
test("effective credential restore supports replacement without hardlinks; keep preserves original",async t=>{
  const f=await fixture(t);await f.put("auth.json",'{"key":"SECRET"}');await createBackup(f);const info=await inspectBackup({archivePath:f.outputPath,password:f.password});
  await fs.writeFile(path.join(f.target,"auth.json"),'{"key":"OLD"}');
  const base={agentDir:f.target,homeDir:f.homeDir,archivePath:f.outputPath,password:f.password,configurationConsent:true};
  const keep=await restoreBackup({...base,decisions:choices(info).map(d=>({...d,conflict:"keep"}))});assert.equal(keep.skipped,1);assert.equal(JSON.parse(await fs.readFile(path.join(f.target,"auth.json"),"utf8")).key,"OLD");
  const result=await restoreBackup({...base,decisions:choices(info)});assert.equal(result.restored,1);assert.equal(JSON.parse(await fs.readFile(path.join(f.target,"auth.json"),"utf8")).key,"SECRET");assert.ok(!(await fs.readdir(f.target)).includes("backup-imports"));
});
test("unapproved executable resources do not enter discoverable directories",async t=>{
  const f=await fixture(t);await f.put("extensions/test.ts","throw new Error('never execute')");await createBackup(f);const info=await inspectBackup({archivePath:f.outputPath,password:f.password});
  const result=await restoreBackup({agentDir:f.target,homeDir:f.homeDir,archivePath:f.outputPath,password:f.password,configurationConsent:true,decisions:choices(info).map(d=>({...d,activation:"defer"}))});assert.equal(result.restored,0);assert.ok(result.deferred>0);await assert.rejects(fs.stat(path.join(f.target,"extensions")),{code:"ENOENT"});
});
test("project tools require mapping and restore no business source",async t=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.projectDir,".pi"));await fs.writeFile(path.join(f.projectDir,".pi","subagents.json"),"{}");await fs.writeFile(path.join(f.projectDir,"business.ts"),"business");
  await createBackup({...f,projectDirs:[f.projectDir]});const info=await inspectBackup({archivePath:f.outputPath,password:f.password});const root=info.manifest.roots.find(r=>r.kind==="project");
  const unmapped=await planRestore({manifest:info.manifest,agentDir:f.target,homeDir:f.homeDir});assert.ok(unmapped.resources.some(r=>!r.mapped));
  const projectDest=path.join(f.home,"new-project");await fs.mkdir(projectDest);await restoreBackup({agentDir:f.target,homeDir:f.homeDir,archivePath:f.outputPath,password:f.password,mappings:{[root.id]:projectDest},decisions:choices(info),configurationConsent:true});
  assert.equal(await fs.readFile(path.join(projectDest,".pi","subagents.json"),"utf8"),"{}");await assert.rejects(fs.stat(path.join(projectDest,"business.ts")),{code:"ENOENT"});
});
