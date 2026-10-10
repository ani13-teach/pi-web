import assert from 'node:assert/strict';
import test from 'node:test';
import { ProcessTreeScope, processTree } from '../desktop/process-tree.ts';

const identity = (pid, ppid, second = 1) => ({pid,ppid,createdAt:`2026-10-10T09:00:${String(second).padStart(2,'0')}.000`});
const root = identity(123001,1);
const child = identity(123002,root.pid,2);
const leaf = identity(123003,child.pid,3);
const unrelated = identity(123004,1,4);
function fixture(initial) {
  let list = initial;
  const kills = [];
  const operations = {
    async list() { return [...list]; },
    async kill(targets) {
      kills.push(targets.map(p=>p.pid));
      const gone = new Set(targets.flatMap(p=>processTree(p,list).map(x=>x.pid)));
      list = list.filter(p=>!gone.has(p.pid));
    },
  };
  return {operations,kills,set(next){list=next;},get list(){return list;}};
}

test('tree selection excludes unrelated processes and stale PPIDs',()=>{
  const stale=identity(123005,root.pid,0);
  assert.deepEqual(processTree(root,[unrelated,leaf,stale,child,root]).map(p=>p.pid),[root.pid,child.pid,leaf.pid]);
});
test('invalid roots cannot kill this host',()=>{
  for(const pid of [0,-1,NaN,process.pid]) assert.throws(()=>new ProcessTreeScope(pid),/Invalid child/);
});
test('termination includes all current descendants but leaves another instance alone',async()=>{
  const f=fixture([root,child,leaf,unrelated]);
  const scope=new ProcessTreeScope(root.pid,f.operations,'win32');
  await scope.capture();
  await scope.terminate();
  assert.deepEqual(f.kills,[[root.pid]]);
  assert.deepEqual(f.list,[unrelated]);
});
test('observed orphans are still owned after their parent exits',async()=>{
  const f=fixture([root,child,leaf,unrelated]);
  const scope=new ProcessTreeScope(root.pid,f.operations,'win32');
  await scope.capture();
  f.set([root,leaf,unrelated]);
  await scope.terminate();
  assert.deepEqual(f.kills,[[root.pid,leaf.pid]]);
  assert.deepEqual(f.list,[unrelated]);
});
test('a reused root PID and its new children are not killed',async()=>{
  const f=fixture([root,child,leaf]);
  const scope=new ProcessTreeScope(root.pid,f.operations,'win32');
  await scope.capture();
  const reused=identity(root.pid,unrelated.pid,8), stranger=identity(123006,root.pid,9);
  f.set([reused,stranger,leaf]);
  await scope.terminate();
  assert.deepEqual(f.kills,[[leaf.pid]]);
  assert.deepEqual(f.list,[reused,stranger]);
});
test('new descendants of a still-owned live parent are captured before termination',async()=>{
  const f=fixture([root,child]);
  const scope=new ProcessTreeScope(root.pid,f.operations,'win32');
  await scope.capture();
  f.set([root,child,leaf,unrelated]);
  await scope.terminate();
  assert.deepEqual(f.list,[unrelated]);
});
test('an already ended root is not adopted if its PID is later reused',async()=>{
  const f=fixture([unrelated]);
  const scope=new ProcessTreeScope(root.pid,f.operations,'win32');
  await scope.capture();
  f.set([identity(root.pid,1,8),child,unrelated]);
  await scope.terminate();
  assert.deepEqual(f.kills,[]);
});
test('the first snapshot cannot claim a reused PID outside the actual spawn interval',async()=>{
  const f=fixture([identity(root.pid,1,9),identity(123006,root.pid,10)]);
  const born=Date.parse(root.createdAt+'Z');
  const scope=new ProcessTreeScope(root.pid,f.operations,'win32',{
    createdAfter:born-1,createdBefore:born+20,isCurrent:()=>true,
  });
  await assert.rejects(scope.terminate(),/does not match/);assert.deepEqual(f.kills,[]);
});
test('an exited child is not adopted before its first snapshot',async()=>{
  const f=fixture([identity(root.pid,1,9)]);
  const scope=new ProcessTreeScope(root.pid,f.operations,'win32',{
    createdAfter:0,createdBefore:1,isCurrent:()=>false,
  });
  await scope.terminate();assert.deepEqual(f.kills,[]);
});
test('a child that exits during the first query is not re-adopted',async()=>{
  const f=fixture([identity(root.pid,1,9)]);let current=true;
  const operations={...f.operations,list:async()=>{current=false;return f.list;}};
  const scope=new ProcessTreeScope(root.pid,operations,'win32',{
    createdAfter:0,createdBefore:1,isCurrent:()=>current,
  });
  await scope.terminate();assert.deepEqual(f.kills,[]);
});
test('enumeration failure is propagated without guessing an owned PID',async()=>{
  let killed=false;
  const scope=new ProcessTreeScope(root.pid,{list:async()=>{throw new Error('CIM unavailable');},kill:async()=>{killed=true;}},'win32');
  await assert.rejects(scope.terminate(),/CIM unavailable/);
  assert.equal(killed,false);
});
test('termination failure is not reported as success',async()=>{
  const scope=new ProcessTreeScope(root.pid,{list:async()=>[root],kill:async()=>{throw new Error('access denied');}},'win32');
  await assert.rejects(scope.terminate(),/access denied/);
});
test('a successful kill status without disappearance cannot exceed the deadline',async()=>{
  const scope=new ProcessTreeScope(root.pid,{list:async()=>[root],kill:async()=>{await new Promise(r=>setTimeout(r,10));}},'win32');
  await assert.rejects(scope.terminate(20),/Timed out/);
});
