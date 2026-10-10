import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
const {outputFiles}=await build({entryPoints:['lib/terminal-manager.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
function fixture(platform) {
  const signals=[],timers=[];
  const record={pty:{kill:signal=>{if(platform==='win32'&&signal)throw new Error('Signals not supported on windows.');signals.push(signal);}},exited:false,cleanupTimer:null,listeners:new Set()};
  const map=new Map([['terminal',record]]);
  const context={require:createRequire(import.meta.url),module:{exports:{}},exports:{},process:{platform,env:{},once(){}},
    __piWebTerminals:map,setTimeout:callback=>{timers.push(callback);return {unref(){}};},clearTimeout(){}};
  vm.runInNewContext(outputFiles[0].text,context);
  return {kill:context.module.exports.killTerminal,map,signals,timers};
}
test('Windows force-close uses node-pty native tree kill without a POSIX signal',()=>{
  const f=fixture('win32');assert.equal(f.kill('terminal',true),true);assert.deepEqual(f.signals,[undefined]);assert.equal(f.map.size,0);
});
test('Windows delayed hard-close also omits unsupported POSIX signals',()=>{
  const f=fixture('win32');f.kill('terminal');f.timers[0]();assert.deepEqual(f.signals,[undefined,undefined]);
});
test('POSIX force and delayed hard-close retain SIGKILL',()=>{
  const force=fixture('linux');force.kill('terminal',true);assert.deepEqual(force.signals,['SIGKILL']);
  const graceful=fixture('linux');graceful.kill('terminal');graceful.timers[0]();assert.deepEqual(graceful.signals,[undefined,'SIGKILL']);
});
