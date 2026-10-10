import assert from 'node:assert/strict';
import test from 'node:test';
import { createQuitHandler } from '../desktop/quit-lifecycle.ts';
const tick=()=>new Promise(r=>setImmediate(r));
const event=()=>({prevented:0,preventDefault(){this.prevented++;}});
function fixture(overrides={}) {
  const calls=[],errors=[];
  const timers=new Map();
  let next=1;
  const quit=createQuitHandler({
    begin:()=>calls.push('begin'),teardown:()=>[()=>calls.push('ui')],shutdown:async()=>calls.push('shutdown'),
    exit:()=>calls.push('exit'),report:e=>errors.push(e),
    setTimer:callback=>{const id=next++;timers.set(id,callback);return id;},clearTimer:id=>timers.delete(id),...overrides,
  });
  return {quit,calls,errors,timers};
}
test('quit seals state before teardown and exits once after shutdown',async()=>{
  const f=fixture();const e=event();f.quit(e);await tick();
  assert.equal(e.prevented,1);assert.deepEqual(f.calls,['begin','ui','shutdown','exit']);assert.equal(f.timers.size,0);
});
test('native destroy exceptions do not skip other windows or shutdown',async()=>{
  let other=false;
  const f=fixture({teardown:()=>[()=>{throw new Error('tray destroy');},()=>{other=true;},()=>{throw new Error('window destroy');}]});
  f.quit(event());await tick();assert.equal(other,true);assert.deepEqual(f.calls,['begin','shutdown','exit']);assert.equal(f.errors.length,2);
});
test('failure while collecting windows still executes backend cleanup',async()=>{
  const f=fixture({teardown:()=>{throw new Error('enumeration');}});f.quit(event());await tick();
  assert.deepEqual(f.calls,['begin','shutdown','exit']);assert.equal(f.errors.length,1);
});
test('synchronous or asynchronous shutdown errors are caught before exit',async()=>{
  for(const shutdown of [()=>{throw new Error('sync');},async()=>{throw new Error('async');}]) {
    const f=fixture({shutdown});f.quit(event());await tick();assert.deepEqual(f.calls,['begin','ui','exit']);assert.equal(f.errors.length,1);
  }
});
test('reentrant quit is prevented and does not run duplicate cleanup',async()=>{
  const f=fixture();const e=event();f.quit(e);f.quit(e);await tick();f.quit(e);
  assert.equal(e.prevented,3);assert.equal(f.calls.filter(x=>x==='shutdown').length,1);assert.equal(f.calls.filter(x=>x==='exit').length,1);
});
test('deadline is armed even when shutdown never resolves',async()=>{
  const f=fixture({shutdown:()=>new Promise(()=>{})});f.quit(event());await tick();
  [...f.timers.values()][0]();assert.equal(f.errors.length,1);assert.equal(f.calls.at(-1),'exit');assert.equal(f.timers.size,0);
});
test('a late shutdown resolution cannot exit a second time after the deadline',async()=>{
  let done;const f=fixture({shutdown:()=>new Promise(r=>{done=r;})});f.quit(event());await tick();
  [...f.timers.values()][0]();done();await tick();assert.equal(f.calls.filter(x=>x==='exit').length,1);
});
