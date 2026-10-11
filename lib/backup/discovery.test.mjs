import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {collectBackup,createBackup,inspectBackup,restoreBackup,planRestore} from "./index.ts";
import {validateManifest,writeArchive} from "./archive.ts";
import {createHash} from "node:crypto";
async function fixture(t){const home=await fs.mkdtemp(path.join(os.tmpdir(),"pi-backup-discovery-"));t.after(()=>fs.rm(home,{recursive:true,force:true}));const agentDir=path.join(home,"agent"),homeDir=path.join(home,"user"),target=path.join(home,"target");await Promise.all([agentDir,homeDir,target].map(p=>fs.mkdir(p)));return{home,agentDir,homeDir,target,outputPath:path.join(home,"archive.pibak"),password:"synthetic-password"};}
test('tool-directory settings and nested declarations agree with archive safety checks',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.agentDir,'extensions','pi-automode'),{recursive:true});
  await fs.mkdir(path.join(f.agentDir,'agents'),{recursive:true});
  await fs.writeFile(path.join(f.agentDir,'extensions','pi-automode','index.ts'),'// synthetic plugin');
  await fs.writeFile(path.join(f.agentDir,'agents','settings.json'),'{}');
  await fs.writeFile(path.join(f.agentDir,'settings.json'),JSON.stringify({nested:{extensions:['synthetic.js'],packages:['synthetic-package']}}));
  const c=await collectBackup(f);
  assert.deepEqual(c.preview.blockers,[]);
  for(const rel of ['extensions/pi-automode','agents/settings.json','settings.json'])
    assert.equal(c.manifest.resources.find(r=>r.relativePath===rel)?.executable,true,rel);
  validateManifest(c.manifest);
  await createBackup(f);
  const info=await inspectBackup({archivePath:f.outputPath,password:f.password});
  validateManifest(info.manifest);
  await assert.rejects(inspectBackup({archivePath:f.outputPath,password:'wrong-password'}),/Invalid backup or password/);
  const invalid=structuredClone(c.manifest);
  invalid.resources.find(r=>r.relativePath==='agents/settings.json').executable=false;
  assert.throws(()=>validateManifest(invalid),/Invalid backup or password/);
});
test('linked tool boundary is copied as content; nested link loops block completeness',async t=>{const f=await fixture(t);const tools=path.join(f.homeDir,'.agents','skills'),actual=path.join(f.home,'actual-skill');await fs.mkdir(tools,{recursive:true});await fs.mkdir(actual);await fs.writeFile(path.join(actual,'SKILL.md'),'# Full linked skill');await fs.writeFile(path.join(actual,'data.db'),'asset');await fs.mkdir(path.join(actual,'assets','logs'),{recursive:true});await fs.writeFile(path.join(actual,'assets','logs','example.log'),'required sample');await fs.writeFile(path.join(actual,'debug.log'),'runtime log');try{await fs.symlink(actual,path.join(tools,'linked'),process.platform==='win32'?'junction':'dir');}catch(e){if(e.code==='EPERM'){t.skip('Host does not allow link creation');return;}throw e;}const first=await collectBackup(f);assert.equal(first.preview.blockers.length,0);assert.ok(first.manifest.entries.some(e=>e.relativePath.endsWith('linked/data.db')));assert.ok(first.manifest.entries.some(e=>e.relativePath.endsWith('linked/assets/logs/example.log')));assert.ok(!first.manifest.entries.some(e=>e.relativePath.endsWith('linked/debug.log')));await fs.symlink(actual,path.join(actual,'loop'),process.platform==='win32'?'junction':'dir');const loop=await collectBackup(f);assert.ok(loop.preview.blockers.some(x=>/cycle/.test(x)));});
test('command credentials and embedded policy require executable/security consent',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.agentDir,'auth.json'),'{"provider":{"key":"!do-not-run"}}');await fs.writeFile(path.join(f.agentDir,'settings.json'),'{"permissions":{"deny":["x"]}}');const c=await collectBackup(f);assert.equal(c.manifest.resources.find(r=>r.relativePath==='auth.json').executable,true);assert.equal(c.manifest.resources.find(r=>r.relativePath==='settings.json').securityPolicy,true);await createBackup(f);const info=await inspectBackup({archivePath:f.outputPath,password:f.password});const result=await restoreBackup({agentDir:f.target,homeDir:f.homeDir,archivePath:f.outputPath,password:f.password,configurationConsent:true,decisions:info.manifest.resources.map(r=>({resourceId:r.id,conflict:'replace',activation:'defer'}))});assert.equal(result.restored,0);assert.ok(result.deferred>=2);});
test('mixed settings never activate references to unapproved/unmapped extensions',async t=>{const f=await fixture(t);const ext=path.join(f.home,'extension.js');await fs.writeFile(ext,'throw new Error("never execute")');await fs.writeFile(path.join(f.agentDir,'settings.json'),JSON.stringify({extensions:[ext],theme:'dark'}));await createBackup(f);const info=await inspectBackup({archivePath:f.outputPath,password:f.password});const result=await restoreBackup({agentDir:f.target,homeDir:f.homeDir,archivePath:f.outputPath,password:f.password,configurationConsent:true,decisions:info.manifest.resources.map(r=>({resourceId:r.id,conflict:'replace',activation:r.kind==='settings'?'enable':'defer'}))});assert.equal(result.restored,0);assert.ok(result.warnings.some(x=>/referenced tools/.test(x)));await assert.rejects(fs.stat(path.join(f.target,'settings.json')),{code:'ENOENT'});});
test('credential-bearing package URLs stay encrypted/private and never enter public previews',async t=>{const f=await fixture(t);const source='npm:synthetic@https://user:SYNTHETIC_URL_KEY@example.invalid/tool.tgz';await fs.writeFile(path.join(f.agentDir,'settings.json'),JSON.stringify({packages:[source]}));const collection=await collectBackup(f);assert.ok(collection.manifest.resources.some(r=>r.source===source));assert.equal(JSON.stringify(collection.preview).includes('SYNTHETIC_URL_KEY'),false);await createBackup(f);const info=await inspectBackup({archivePath:f.outputPath,password:f.password});const preview=await planRestore({manifest:info.manifest,agentDir:f.target,homeDir:f.homeDir});assert.equal(JSON.stringify(preview).includes('SYNTHETIC_URL_KEY'),false);});
test('managed package contents and exact version restore as an approved local source without installation',async t=>{const f=await fixture(t);const pkgDir=path.join(f.agentDir,'npm','node_modules','synthetic-package');await fs.mkdir(pkgDir,{recursive:true});await fs.writeFile(path.join(pkgDir,'package.json'),JSON.stringify({name:'synthetic-package',version:'1.2.3',pi:{extensions:['extension.js']},peerDependencies:{'@earendil-works/pi-coding-agent':'1.1.0'}}));await fs.writeFile(path.join(pkgDir,'extension.js'),'// USER-MODIFIED TOOL');await fs.writeFile(path.join(f.agentDir,'settings.json'),JSON.stringify({packages:['npm:synthetic-package@1.2.3']}));await createBackup(f);const info=await inspectBackup({archivePath:f.outputPath,password:f.password});const captured=info.manifest.resources.find(r=>r.kind==='extensions'&&r.source==='npm:synthetic-package@1.2.3');assert.ok(captured);assert.equal(captured.version,'1.2.3');assert.equal(captured.availability,'offlineReady');const pkgTarget=path.join(f.home,'restored-packages');await fs.mkdir(pkgTarget);const result=await restoreBackup({agentDir:f.target,homeDir:f.homeDir,archivePath:f.outputPath,password:f.password,mappings:{[captured.rootId]:pkgTarget},configurationConsent:true,decisions:info.manifest.resources.map(r=>({resourceId:r.id,conflict:'replace',activation:'enable'}))});assert.ok(result.restored>=3);const settings=JSON.parse(await fs.readFile(path.join(f.target,'settings.json'),'utf8'));assert.deepEqual(settings.packages,[path.join(pkgTarget,'synthetic-package')]);assert.equal(await fs.readFile(path.join(pkgTarget,'synthetic-package','extension.js'),'utf8'),'// USER-MODIFIED TOOL');});
test('shared tool settings have canonical configuration kind and sensitivity',async t=>{
  const f=await fixture(t),dir=path.join(f.homeDir,'.agents','agents');
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'settings.json'),'{}');
  const c=await collectBackup(f),r=c.manifest.resources.find(r=>r.relativePath==='.agents/agents/settings.json');
  assert.equal(r.kind,'settings');assert.equal(r.sensitive,true);assert.equal(r.executable,true);
  validateManifest(c.manifest);await createBackup(f);
});
test('history roots and aliases never become tool dependencies',async t=>{
  const f=await fixture(t),declared=path.join(f.home,'sessions'),custom=path.join(f.agentDir,'skills','helper','saved-work');
  for(const dir of [declared,custom,path.join(f.homeDir,'.agents','skills','sessions')]){
    await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'saved.jsonl'),'PRIVATE_HISTORY');
  }
  await fs.mkdir(path.join(f.agentDir,'agents'));
  await fs.writeFile(path.join(f.agentDir,'agents','helper.md'),'---\nsession_dir: skills/helper/saved-work\n---\nTool instructions');
  await fs.writeFile(path.join(f.agentDir,'settings.json'),JSON.stringify({skills:[declared]}));
  const alias=path.join(f.agentDir,'skills','history-alias');
  try{await fs.symlink(declared,alias,process.platform==='win32'?'junction':'dir');}
  catch(e){if(e.code!=='EPERM')throw e;}
  const c=await collectBackup({...f,resourceSnapshot:[{kind:'skills',path:declared,baseDir:declared}]});
  assert.deepEqual(c.preview.blockers,[]);
  assert.ok(!c.manifest.entries.some(e=>e.relativePath.endsWith('saved.jsonl')));
  validateManifest(c.manifest);
});
test('history descendants and single files are excluded through declarations, snapshots and links',async t=>{
  const f=await fixture(t),work=path.join(f.homeDir,'.agents','skills','sessions','work'),saved=path.join(work,'saved.jsonl');
  await fs.mkdir(work,{recursive:true});await fs.writeFile(saved,'PRIVATE_HISTORY');
  await fs.writeFile(path.join(f.agentDir,'settings.json'),JSON.stringify({skills:[work,saved]}));
  const tool=path.join(f.agentDir,'skills','linked-work');await fs.mkdir(path.dirname(tool),{recursive:true});
  try{await fs.symlink(work,tool,process.platform==='win32'?'junction':'dir');}
  catch(e){if(e.code!=='EPERM')throw e;}
  const c=await collectBackup({...f,resourceSnapshot:[{kind:'skills',path:saved,baseDir:work},{kind:'extensions',path:saved}]});
  assert.deepEqual(c.preview.blockers,[]);validateManifest(c.manifest);
  assert.ok(!c.manifest.entries.some(e=>e.relativePath.endsWith('saved.jsonl')));
  await createBackup({...f,resourceSnapshot:[{kind:'skills',path:saved,baseDir:work},{kind:'extensions',path:saved}]});
});
test('shared, project and snapshot agents exclude arbitrary named history roots before tools',async t=>{
  const f=await fixture(t),project=path.join(f.home,'project'),snapshot=path.join(f.home,'snapshot-agent.md');
  await fs.mkdir(project);await fs.mkdir(path.join(f.homeDir,'.agents','agents'),{recursive:true});await fs.mkdir(path.join(project,'.pi','agents'),{recursive:true});
  const roots=[path.join(f.agentDir,'skills','shared-history'),path.join(project,'.pi','skills','project-history'),path.join(f.agentDir,'skills','snapshot-history')];
  for(const dir of roots){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'saved.jsonl'),'PRIVATE_HISTORY');}
  for(const [file,dir] of [[path.join(f.homeDir,'.agents','agents','helper.md'),roots[0]],[path.join(project,'.pi','agents','helper.md'),roots[1]],[snapshot,roots[2]]])
    await fs.writeFile(file,'---\nsession_dir: '+dir+'\n---\nRequired agent instructions');
  const c=await collectBackup({...f,projectDirs:[project],resourceSnapshot:[{kind:'agents',path:snapshot}]});
  assert.deepEqual(c.preview.blockers,[]);validateManifest(c.manifest);
  assert.ok(!c.manifest.entries.some(e=>e.relativePath.endsWith('saved.jsonl')));
  assert.equal(c.manifest.entries.filter(e=>e.relativePath.endsWith('helper.md')||e.relativePath==='snapshot-agent.md').length,3);
});
test('tool links cannot archive an authorized whole project or its source',async t=>{
  const f=await fixture(t),project=path.join(f.home,'project'),tool=path.join(f.agentDir,'skills','whole-project');
  await fs.mkdir(project);await fs.writeFile(path.join(project,'main.ts'),'BUSINESS_SOURCE');await fs.writeFile(path.join(project,'AGENTS.md'),'PROJECT_INSTRUCTIONS');
  await fs.mkdir(path.dirname(tool),{recursive:true});
  try{await fs.symlink(project,tool,process.platform==='win32'?'junction':'dir');}
  catch(e){if(e.code==='EPERM'){t.skip('Host does not allow link creation');return;}throw e;}
  const c=await collectBackup({...f,projectDirs:[project]});
  assert.ok(c.preview.blockers.some(s=>/entire environment\/project/.test(s)));
  assert.ok(!c.manifest.entries.some(e=>/main.ts|AGENTS.md/.test(e.relativePath)));
  await assert.rejects(createBackup({...f,projectDirs:[project]}),/Backup incomplete/);
});
test('previous v2 session backups still restore mapped headers without rewriting transcript',async t=>{
  const f=await fixture(t),oldWorkspace=path.join(f.home,'old-project'),newWorkspace=path.join(f.home,'new-project');
  await fs.mkdir(newWorkspace);
  const data=Buffer.from(JSON.stringify({type:'session',version:3,id:'saved',cwd:oldWorkspace})+'\n'+JSON.stringify({type:'message',message:{role:'user',content:oldWorkspace}})+'\n');
  const c=await collectBackup(f),root=c.manifest.roots.find(r=>r.kind==='agent');
  c.manifest.roots.push({id:'workspace',kind:'project',label:'Historical workspace',originalPath:oldWorkspace});
  c.manifest.resources.push({id:'saved',rootId:root.id,relativePath:'sessions/workspace',label:'Historical sessions',kind:'session',executable:false,sensitive:true,availability:'offlineReady',requiredRootIds:['workspace']});
  const e={path:root.id+'/sessions/workspace/saved.jsonl',rootId:root.id,resourceId:'saved',relativePath:'sessions/workspace/saved.jsonl',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),kind:'session'};
  c.manifest.entries.push(e);c.entries.push({...e,data});
  await writeArchive({outputPath:f.outputPath,password:f.password,collection:c});
  const info=await inspectBackup({archivePath:f.outputPath,password:f.password});
  await restoreBackup({agentDir:f.target,homeDir:f.homeDir,archivePath:f.outputPath,password:f.password,mappings:{workspace:newWorkspace},configurationConsent:true,decisions:info.manifest.resources.map(r=>({resourceId:r.id,conflict:'replace',activation:'enable'}))});
  const lines=(await fs.readFile(path.join(f.target,'sessions','workspace','saved.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].cwd,newWorkspace);assert.equal(lines[1].message.content,oldWorkspace);
});
test('new exports exclude histories and project instructions from every discovery input',async t=>{
  const f=await fixture(t),project=path.join(f.home,'project'),saved=path.join(f.home,'custom-history');
  async function put(base,rel,data){const p=path.join(base,rel);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,data);}
  await fs.mkdir(project);await fs.mkdir(saved);
  await put(saved,'saved.jsonl','{"type":"session","cwd":"PRIVATE_WORKSPACE"}\n');
  await put(f.agentDir,'sessions/work/saved.jsonl','PRIVATE_HISTORY');
  await put(f.agentDir,'agent-memory/private.md','PRIVATE_MEMORY');
  await put(f.homeDir,'.pi/agent-memory/private.md','PRIVATE_MEMORY');
  await put(f.agentDir,'settings.json',JSON.stringify({sessionDir:saved}));
  await put(f.agentDir,'models.json','{"providers":{}}');
  await put(f.agentDir,'agents/helper.md','---\nsession_dir: '+saved+'\n---\nTool instructions');
  await put(f.agentDir,'skills/example/SKILL.md','Required skill documentation');
  await put(f.agentDir,'skills/example/scripts/run.py','Required tool code');
  await put(f.agentDir,'extensions/example/index.ts','Required plugin code');
  await put(f.agentDir,'extensions/example/sessions/private.jsonl','PRIVATE_HISTORY');
  for(const rel of ['AGENTS.md','CLAUDE.md','.pi/AGENTS.md','.pi/SYSTEM.md','README.md','main.ts','.pi/sessions/work/saved.jsonl','.pi/agent-memory-local/notes.md'])
    await put(project,rel,'PRIVATE_PROJECT_CONTENT');
  await put(project,'.pi/settings.json','{}');
  await put(project,'.pi/skills/project-tool/SKILL.md','Required project skill');
  const o={...f,projectDirs:[project],sessionDirs:[saved],resourceSnapshot:[
    {kind:'instructions',path:path.join(project,'AGENTS.md')},
    {kind:'skills',path:path.join(saved,'saved.jsonl'),baseDir:saved}]};
  const c=await collectBackup(o);
  assert.deepEqual(c.preview.blockers,[]);
  validateManifest(c.manifest);
  assert.ok(!c.manifest.resources.some(r=>['session','sessions','memory'].includes(r.kind)));
  assert.ok(!c.entries.some(e=>e.source?.startsWith(saved)));
  const projectEntries=c.manifest.entries.filter(e=>c.manifest.roots.find(r=>r.id===e.rootId)?.kind==='project');
  assert.deepEqual(projectEntries.map(e=>e.relativePath).sort(),['.pi/settings.json','.pi/skills/project-tool/SKILL.md']);
  for(const rel of ['models.json','skills/example/SKILL.md','skills/example/scripts/run.py','extensions/example/index.ts','agents/helper.md'])
    assert.ok(c.manifest.entries.some(e=>e.relativePath===rel),rel);
  assert.ok(!c.manifest.entries.some(e=>/sessions|agent-memory/.test(e.relativePath)));
  await createBackup(o);
  const info=await inspectBackup({archivePath:f.outputPath,password:f.password});
  assert.deepEqual(info.manifest.entries,c.manifest.entries);
});
