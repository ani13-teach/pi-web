/** Windows-only, isolated real tray IPC / packaged backend regression. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { readWindowsProcesses, processTree, ProcessTreeScope, sameProcess } from '../desktop/process-tree.ts';

if (process.platform !== 'win32') { console.log('SKIP: Windows tray shutdown regression'); process.exit(0); }
const require=createRequire(import.meta.url);
const arg=process.argv.indexOf('--binary');
const binary=resolve(arg>=0?process.argv[arg+1]:'release/quit-fix/win-unpacked/Pi Desktop.exe');
assert.ok(existsSync(binary),`Missing ${binary}; package the application first`);
const appRoot=join(dirname(binary),'resources','app.asar');
const mainFile=join(appRoot,'dist','main','main.cjs');
// Electron's ASAR reads occur in the Electron harness, not in this Node runner.
const backendFile=join(dirname(binary),'resources','app.asar.unpacked','dist','main','backend.mjs');
const harnessRuntime=require('electron');
const initial=await readWindowsProcesses();
const protectedProcesses=initial.filter(p=>p.pid===process.ppid); // Must not terminate this runner's parent.
const root=await mkdtemp(join(tmpdir(),'pi-quit-regression-'));
// An independent same-named runtime must survive all three test exits.
const companion=spawn(binary,['-e','setInterval(()=>{},1000)'],{
  env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore',windowsHide:true,
});
const companionIdentity=(await readWindowsProcesses()).find(p=>p.pid===companion.pid);
assert.ok(companionIdentity,'independent Pi Desktop runtime did not start');
protectedProcesses.push(companionIdentity);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const seenOwned=new Map();
let active;
let passed=false;

async function waitFor(check,label,ms=20_000) {
  const deadline=Date.now()+ms;
  while(Date.now()<deadline) { if(await check())return; await sleep(75); }
  throw new Error(`Timed out: ${label}`);
}
try {
  // Runtime-level runNpx is bundled with the same implementation as the backend.
  await build({entryPoints:['lib/npx.ts'],bundle:true,platform:'node',format:'esm',outfile:join(root,'npx.mjs')});
  for(const mode of ['idle','task','hung']) {
    const dir=join(root,mode);await mkdir(join(dir,'userdata'),{recursive:true});
    const log=join(dir,'events.jsonl');
    const wrapper=join(dir,'backend.mjs');
    const tasks=join(dir,'task.cjs');
    await writeFile(tasks,`
const fs=require('node:fs'),{spawn}=require('node:child_process'),path=require('node:path');
const depth=Number(process.argv[2]||0);
fs.writeFileSync(path.join(__dirname,'pid-'+process.pid+'.json'),JSON.stringify({pid:process.pid,ppid:process.ppid}));
if(depth<2)spawn(process.execPath,[__filename,String(depth+1)],{stdio:'ignore',windowsHide:true});
setInterval(()=>{},1000);
`);
    await writeFile(wrapper,mode==='hung'?`
import{writeFileSync}from'node:fs';
writeFileSync(${JSON.stringify(join(dir,'backend-ready'))},String(process.pid));
process.on('message',()=>{});setInterval(()=>{},1000);
`:`
await import(${JSON.stringify(pathToFileURL(backendFile).href)});
import{writeFileSync,appendFileSync}from'node:fs';
writeFileSync(${JSON.stringify(join(dir,'backend-ready'))},String(process.pid));
${mode==='task'?`
const{runNpx,stopNpxProcesses}=await import(${JSON.stringify(pathToFileURL(join(root,'npx.mjs')).href)});
const command='call "'+process.execPath+'" "'+${JSON.stringify(tasks)}+'"';
void runNpx(['--offline','-c',command],{timeout:60_000,env:{...process.env,npm_config_cache:${JSON.stringify(join(dir,'npm-cache'))},npm_config_offline:'true'}}).catch(()=>{});
process.on('message',m=>{if(m?.envelope?.method==='backend.shutdown')void stopNpxProcesses().catch(e=>appendFileSync(${JSON.stringify(log)},JSON.stringify({cleanupError:String(e)})+'\\n'));});
`:''}
`);
    const tail=`
{
const fsProbe=require('node:fs');
const record=x=>fsProbe.appendFileSync(${JSON.stringify(log)},JSON.stringify({...x,at:Date.now()})+'\\n');
process.on('uncaughtException',e=>record({uncaught:e.stack}));
process.on('unhandledRejection',e=>record({unhandled:String(e)}));
import_electron.app.on('quit',()=>record({event:'quit'}));
import_electron.app.whenReady().then(()=>setTimeout(async()=>{
 try {
  while(!fsProbe.existsSync(${JSON.stringify(join(dir,'backend-ready'))}))await new Promise(r=>setTimeout(r,50));
  ${mode==='task'?`while(fsProbe.readdirSync(${JSON.stringify(dir)}).filter(n=>n.startsWith('pid-')).length<3)await new Promise(r=>setTimeout(r,50));`:''}
  record({event:'ready',mainPid:process.pid,backendPid:backend.pid});
  mainWindow.close();record({event:'close',hidden:!mainWindow.isVisible(),backendAlive:backend.running});
  const popup=createTrayWindow();
  await new Promise(r=>popup.webContents.once('did-finish-load',r));
  record({event:'click'});
  await popup.webContents.executeJavaScript("document.getElementById('quit-app').click()");
 }catch(e){record({testError:e.stack});import_electron.app.exit(2);}
},1000));
}
`;
    const launcher=join(dir,'main.cjs');
    // Preserve the exact built main code. Only test launch paths and observation
    // hooks differ: no shutdown/IPC handlers are replaced by mocks.
    await writeFile(launcher,`
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{app}=require('electron');
app.setPath('userData',${JSON.stringify(join(dir,'userdata'))});
process.env.PI_CODING_AGENT_DIR=${JSON.stringify(join(dir,'agent'))};
process.env.PI_OFFLINE='1';process.env.PI_TELEMETRY='0';
delete process.env.PI_DESKTOP_SMOKE;delete process.env.PI_DESKTOP_SCENARIO;
const filename=${JSON.stringify(mainFile)};
let source=fs.readFileSync(filename,'utf8');
source=source.replace(/var backendEntry = .*;/,'var backendEntry = '+JSON.stringify(${JSON.stringify(wrapper)})+';');
source=source.replace('execPath: process.execPath,','execPath: '+JSON.stringify(${JSON.stringify(binary)})+',');
source=source.replace('}).catch(() => {\\n    import_electron.dialog.showErrorBox','}).catch((error) => {\\n    console.error(error); import_electron.dialog.showErrorBox');
require('electron').dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(2);};
const tail=${JSON.stringify(tail)};
const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(source+tail,filename);
`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    active=spawn(harnessRuntime,[launcher],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stderr='',exit=null;
    active.stdout.on('data',()=>{});active.stderr.on('data',x=>{stderr+=x;});
    active.on('exit',(code,signal)=>{exit={code,signal};});
    // Snapshot the tree before shutdown, including intermediate cmd/npm PIDs.
    await waitFor(async()=>{
      await writeFile(join(dir,'stderr.log'),stderr);
      if (exit) throw new Error(`${mode} exited before the tray test: ${JSON.stringify(exit)} ${stderr}`);
      if (existsSync(log)) {
        const text=await readFile(log,'utf8');
        if (/"(uncaught|unhandled|testError)":/.test(text)) throw new Error(text);
      }
      const list=await readWindowsProcesses();const parent=list.find(p=>p.pid===active.pid);
      if(parent)for(const p of processTree(parent,list))seenOwned.set(p.pid,p);
      return existsSync(log) && (await readFile(log,'utf8')).includes('"event":"click"');
    },`${mode} tray button`,25_000);
    await waitFor(()=>exit!==null,`${mode} OS process exit`,22_000);
    assert.equal(exit.code,0,`${mode} failed: ${stderr}`);
    const events=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(x=>x.event==='close'&&x.hidden&&x.backendAlive),'closing the main window must still retain the tray');
    assert.ok(!events.some(x=>x.uncaught||x.unhandled||x.testError),JSON.stringify(events));
    const live=await readWindowsProcesses();
    const survivors=live.filter(p=>seenOwned.has(p.pid)&&sameProcess(p,seenOwned.get(p.pid)));
    assert.deepEqual(survivors,[],`${mode} left owned processes alive`);
    for(const p of protectedProcesses)assert.ok(live.some(x=>sameProcess(x,p)),'unrelated parent was terminated');
    console.log(`PASS ${mode}: real tray IPC, backend and observed descendants exited; close-to-tray preserved`);
    active=null;
  }
  passed=true;
} finally {
  if(active) {
    try{await new ProcessTreeScope(active.pid).terminate();}catch{try{active.kill('SIGKILL');}catch{}}
  }
  // Clean only identities observed under this isolated test's own main PID.
  const live=await readWindowsProcesses();
  for(const p of live)if(seenOwned.has(p.pid)&&sameProcess(p,seenOwned.get(p.pid))) {
    try{await new ProcessTreeScope(p.pid).terminate();}catch{}
  }
  try{await new ProcessTreeScope(companion.pid).terminate();}catch{try{companion.kill('SIGKILL');}catch{}}
  if(passed) await rm(root,{recursive:true,force:true});
  else console.error(`Test diagnostics retained at ${root}`);
}
