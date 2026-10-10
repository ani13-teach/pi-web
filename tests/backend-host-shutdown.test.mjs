import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
const source=await readFile(new URL('../desktop/main.ts',import.meta.url),'utf8');
const start=source.indexOf('class BackendHost {');
const end=source.indexOf('// ---------------------------------------------------------------------------\n// window',start);
const {code}=await transform(source.slice(start,end)+'\nglobalThis.Host=BackendHost;', {loader:'ts',format:'cjs',target:'node24'});
function fixture({closed=true,respond=true,scopeFails=false,exitOnKill=true,platform='win32'}={}) {
  const calls=[];const messages=[];const child=new EventEmitter();
  Object.assign(child,{pid:123451,exitCode:null,signalCode:null,connected:true,stdout:new EventEmitter(),stderr:new EventEmitter()});
  const finish=()=>{if(child.exitCode!==null)return;child.exitCode=0;child.emit('exit',0,null);};
  child.send=message=>{messages.push(message);if(respond)queueMicrotask(()=>child.emit('message',{kind:'response',envelope:{id:message.envelope.id,ok:true,result:{closed}}}));};
  child.kill=()=>{calls.push('root-kill');if(exitOnKill)finish();return true;};
  class Scope {async capture(){calls.push('capture');}async terminate(){calls.push('tree-kill');if(scopeFails)throw new Error('tree failure');if(exitOnKill)finish();}}
  const context={fork:()=>{calls.push('start');return child;},backendEntry:'fixture',app:{getPath:()=>'.'},process:{platform,env:{},execPath:'fixture'},
    AbortController,randomUUID:()=>String(messages.length),setTimeout,clearTimeout,delay:ms=>new Promise(r=>setTimeout(r,ms)),ProcessTreeScope:Scope,
    console:{log(){},error(){}},session:{},};
  vm.runInNewContext(code,context);const host=new context.Host(()=>{});host.start();
  return {host,child,calls,messages,finish};
}
test('Windows holds the root through resource cleanup and kills its tree before returning',async()=>{
  const f=fixture();await f.host.shutdown(200);
  assert.equal(f.messages[0].envelope.params.holdForExit,true);
  assert.deepEqual(f.calls,['start','capture','tree-kill']);assert.equal(f.host.running,false);
});
test('concurrent shutdown calls share one operation and block new requests',async()=>{
  const f=fixture();const first=f.host.shutdown(200);const second=f.host.shutdown(200);
  assert.equal(first,second);await assert.rejects(f.host.request('app.info',{}),/shutting down/);
  await first;assert.equal(f.calls.filter(x=>x==='tree-kill').length,1);
});
test('unresponsive backend is still terminated as a tree',async()=>{
  const f=fixture({respond:false});await f.host.shutdown(100);
  assert.ok(f.calls.includes('tree-kill'));assert.equal(f.host.running,false);
});
test('backup rejects a forced stop instead of calling it graceful',async()=>{
  const f=fixture({respond:false});await assert.rejects(f.host.shutdown(100,true),/safely stop/);
  assert.equal(f.host.running,false);
});
test('backup rejects a cleanup acknowledgement with closed false',async()=>{
  const f=fixture({closed:false});await assert.rejects(f.host.shutdown(200,true),/safely stop/);
});
test('backup succeeds only after clean acknowledgement and actual exit',async()=>{
  const f=fixture();await f.host.shutdown(10_000,true);assert.equal(f.host.running,false);
});
test('tree cleanup failure has a handle-based root fallback but remains an error',async()=>{
  const f=fixture({scopeFails:true});await assert.rejects(f.host.shutdown(200),/tree failure/);
  assert.ok(f.calls.includes('root-kill'));assert.equal(f.host.running,false);
});
test('quit during restart permanently prevents a second backend',async()=>{
  const f=fixture();const restart=f.host.restart();f.host.beginQuit();const stop=f.host.shutdown(200);
  await assert.rejects(restart,/quitting/);await stop;
  assert.equal(f.calls.filter(x=>x==='start').length,1);assert.equal(f.host.running,false);
  assert.throws(()=>f.host.start(),/quitting/);
});
test('quit interrupts an existing 30-second backup grace before its exit deadline',async()=>{
  const f=fixture({respond:false});const backup=f.host.shutdown(30_000,true);
  const rejected=assert.rejects(backup,/safely stop/);
  await new Promise(r=>setImmediate(r));assert.equal(f.messages.length,1);
  const started=Date.now();f.host.beginQuit();await rejected;
  assert.ok(Date.now()-started<500,'must not wait out the backup request timeout');
  assert.ok(f.calls.includes('tree-kill'));assert.equal(f.host.running,false);
});
test('a backup cannot inherit success from an already non-graceful stop',async()=>{
  const f=fixture();const stop=f.host.shutdown(200);
  const rejected=assert.rejects(f.host.shutdown(10_000,true),/non-graceful stop/);
  await stop;await rejected;
});
test('a backend that never exits cannot be forgotten or restarted',async()=>{
  const f=fixture({exitOnKill:false});await assert.rejects(f.host.shutdown(30),/still running/);
  assert.equal(f.host.running,true);await assert.rejects(f.host.restart(),/still running/);
  assert.equal(f.calls.filter(x=>x==='start').length,1);
});
