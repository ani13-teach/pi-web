import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type Identity = { dev: number; ino: number };
export type Permissions = { mode: number; uid: number; gid: number; acl?: string };
export type FileState = Identity & Permissions & { hash: string; size: number; mtimeMs: number; ctimeMs: number };
export const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
export function abort(signal?: AbortSignal) { signal?.throwIfAborted(); }

// All scripts are fixed. User paths/data travel through base64 environment values,
// never through a shell, an interpolated command, or a user-configured executable.
const windowsScript = `
$ErrorActionPreference='Stop'
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_BACKUP_PATH))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$item=Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point refused' }
if ($env:PI_BACKUP_ACTION -eq 'protect') {
 $acl=Get-Acl -LiteralPath $p
 $acl.SetAccessRuleProtection($true,$false)
 foreach ($existing in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))) { $acl.PurgeAccessRules($existing.IdentityReference) }
 $acl.SetOwner($sid)
 $inherit=[Security.AccessControl.InheritanceFlags]::None
 if ($item.PSIsContainer) { $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
 foreach ($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
  $rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($id)),[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
 }
 if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($p,$acl) } else { [IO.File]::SetAccessControl($p,$acl) }
}
if ($env:PI_BACKUP_ACTION -eq 'restore') {
 $acl=Get-Acl -LiteralPath $p
 $sddl=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_BACKUP_ACL))
 $acl.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]'Access,Owner,Group')
 if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($p,$acl) } else { [IO.File]::SetAccessControl($p,$acl) }
}
$acl=Get-Acl -LiteralPath $p
if ($env:PI_BACKUP_ACTION -in @('protect','verify')) {
 if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unsafe owner/inheritance' }
 $userFull=$false
 foreach ($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($r.IsInherited -or $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $r.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'Unsafe ACL' }
  if ($r.IdentityReference.Value -eq $sid.Value -and (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)) { $userFull=$true }
 }
 if (!$userFull) { throw 'Missing user ACL' }
}
$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Access,Owner,Group')
`;
const windowsMoveScript = `
$ErrorActionPreference='Stop'
if (!(('PiBackupMove' -as [type]))) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiBackupMove { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool MoveFileEx(string a,string b,uint f); }' }
$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_BACKUP_FROM))
$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_BACKUP_TO))
$replace=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_BACKUP_REPLACE))
$f=8; if ($replace -eq 'true') { $f=9 }
if (![PiBackupMove]::MoveFileEx($a,$b,$f)) { throw 'Atomic move failed' }
`;
let windowsWorker: ChildProcessWithoutNullStreams | undefined;
let windowsSequence = 0;
let windowsIdleTimer: ReturnType<typeof setTimeout> | undefined;
const windowsPending = new Map<number, { resolve: (value:string)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }>();
function workerRef(ref: boolean) {
  const worker = windowsWorker; if (!worker) return;
  if (ref) worker.ref(); else worker.unref();
  for (const stream of [worker.stdin,worker.stdout,worker.stderr]) {
    const handle = stream as typeof stream & { ref?:()=>void; unref?:()=>void };
    if (ref) handle.ref?.(); else handle.unref?.();
  }
}
function systemWorker() {
  if (windowsWorker) return windowsWorker;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows system directory unavailable");
  // Only these two fixed scripts are reachable. Requests carry base64 paths/ACLs,
  // not arbitrary code, commands, user resource strings or decrypted secrets.
  const program = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'\n$actions=@{acl={${windowsScript}};move={${windowsMoveScript}}}\nwhile ($null -ne ($line=[Console]::In.ReadLine())) {\ntry { $q=$line|ConvertFrom-Json; foreach ($v in $q.values.PSObject.Properties) { [Environment]::SetEnvironmentVariable($v.Name,[string]$v.Value) }; if ($q.action -notin @('acl','move')) { throw 'Invalid action' }; $value=& $actions[[string]$q.action]; [Console]::Out.WriteLine((@{id=$q.id;ok=$true;value=($value -join \"\n\")}|ConvertTo-Json -Compress)) } catch { [Console]::Out.WriteLine((@{id=$q.id;ok=$false}|ConvertTo-Json -Compress)) }\n}`;
  const worker = spawn(path.join(systemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe"),["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(program,"utf16le").toString("base64")],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  windowsWorker=worker; let buffer="";
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data",(chunk:string)=>{
    buffer+=chunk;
    if(buffer.length>2*1024*1024){worker.kill();return;}
    for(let newline=buffer.indexOf("\n");newline>=0;newline=buffer.indexOf("\n")) {
      const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
      try {const result=JSON.parse(line) as {id:number;ok:boolean;value:string};const pending=windowsPending.get(result.id);if(!pending)continue;windowsPending.delete(result.id);clearTimeout(pending.timer);if(result.ok)pending.resolve(result.value??"");else pending.reject(new Error("Windows backup permission/atomic file operation failed"));}
      catch {worker.kill();}
    }
    if(windowsPending.size===0) {
      workerRef(false);
      clearTimeout(windowsIdleTimer);
      windowsIdleTimer=setTimeout(()=>{if(windowsWorker===worker && windowsPending.size===0){windowsWorker=undefined;worker.stdin.end();}},10_000);
      windowsIdleTimer.unref();
    }
  });
  worker.stderr.on("data",()=>{}); // Do not forward scripts, paths or ACLs to logs.
  const stopped=()=>{if(windowsWorker!==worker)return;windowsWorker=undefined;for(const pending of windowsPending.values()){clearTimeout(pending.timer);pending.reject(new Error("Windows backup system worker stopped"));}windowsPending.clear();};
  worker.once("error",stopped);worker.once("exit",stopped);return worker;
}
async function powershell(script: string, values: Record<string, string>):Promise<string> {
  const action=script===windowsScript?"acl":script===windowsMoveScript?"move":undefined;
  if(!action)throw new Error("Unknown backup system operation");
  clearTimeout(windowsIdleTimer);
  const worker=systemWorker(),id=++windowsSequence;
  const encoded=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,k==="PI_BACKUP_ACTION"?v:Buffer.from(v).toString("base64")]));
  workerRef(true);
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{windowsPending.delete(id);reject(new Error("Windows backup system operation timed out"));worker.kill();},30_000);
    windowsPending.set(id,{resolve,reject,timer});
    worker.stdin.write(JSON.stringify({id,action,values:encoded})+"\n",error=>{if(error){clearTimeout(timer);windowsPending.delete(id);reject(new Error("Windows backup system worker unavailable"));}});
  });
}
async function acl(p: string, action: "get" | "protect" | "verify" | "restore", saved = "") {
  return powershell(windowsScript, { PI_BACKUP_PATH: p, PI_BACKUP_ACTION: action, PI_BACKUP_ACL: saved });
}
export async function permissions(p: string): Promise<Permissions> {
  const s = await fs.lstat(p);
  return { mode: s.mode & 0o777, uid: s.uid, gid: s.gid, ...(process.platform === "win32" ? { acl: await acl(p, "get") } : {}) };
}
export async function protect(p: string, directory = false) {
  if (process.platform === "win32") await acl(p, "protect");
  else await fs.chmod(p, directory ? 0o700 : 0o600);
  await verifyPrivate(p, directory);
}
export async function verifyPrivate(p: string, directory = false) {
  const s = await fs.lstat(p);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw new Error("Unsafe private path");
  if (process.platform === "win32") await acl(p, "verify");
  else if (s.uid !== process.getuid?.() || (s.mode & 0o777) !== (directory ? 0o700 : 0o600)) throw new Error("Unsafe private permissions");
}
export async function restorePermissions(p: string, saved: Permissions) {
  if (process.platform === "win32") {
    if (!saved.acl) throw new Error("Missing original ACL");
    await acl(p, "restore", saved.acl);
  } else {
    if (saved.uid !== process.getuid?.()) throw new Error("Cannot safely restore foreign-owned file");
    await fs.chmod(p, saved.mode);
  }
  const actual = await permissions(p);
  if (JSON.stringify(actual) !== JSON.stringify(saved)) throw new Error("Permission restoration failed");
}
export function relativePath(p: string, allowEmpty = false) {
  if (allowEmpty && p === "") return p;
  if (typeof p !== "string" || !p || p.length > 4096 || /[\\\x00-\x1f:]/.test(p) || p.startsWith("/") || path.isAbsolute(p)) throw new Error("Invalid relative backup path");
  for (const part of p.split("/")) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || /^\.backup-transactions$|^\.pi-backup-/i.test(part)) throw new Error("Invalid relative backup path");
  }
  return p;
}
export function within(root: string, p: string) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
export async function maybeStat(p: string) {
  try { return await fs.lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
/** Inspect every ancestor, including ancestors of the authorized root. Never follow links. */
export async function checkParents(p: string, allowMissing = false): Promise<{ path: string; identity: Identity }[]> {
  if (!path.isAbsolute(p)) throw new Error("Absolute authorized root required");
  const parsed = path.parse(p), parts = p.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const identities: { path: string; identity: Identity }[] = [];
  for (const component of ["", ...parts]) {
    if (component) current = path.join(current, component);
    const s = await maybeStat(current);
    if (!s) { if (allowMissing) break; throw new Error("Authorized directory unavailable"); }
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Link/reparse or non-directory parent refused");
    const resolved = await fs.realpath(current);
    const normalize = (v: string) => process.platform === "win32" ? path.resolve(v).toLowerCase() : path.resolve(v);
    if (normalize(resolved) !== normalize(current)) throw new Error("Reparse parent refused");
    identities.push({ path: current, identity: { dev: s.dev, ino: s.ino } });
  }
  return identities;
}
export async function checkIdentity(p: string, identity: Identity) {
  const s = await fs.lstat(p);
  if (s.isSymbolicLink() || !sameIdentity(s, identity)) throw new Error("Directory/file identity changed or volume unavailable");
}
export async function verifyParents(identities: { path: string; identity: Identity }[]) {
  for (const item of identities) await checkIdentity(item.path, item.identity);
  await checkParents(identities.at(-1)!.path);
}
export async function fileState(p: string): Promise<FileState | null> {
  const s = await maybeStat(p);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink()) throw new Error("Target is not a regular file");
  await checkParents(path.dirname(p));
  const h = await fs.open(p, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await h.stat();
    if (!sameIdentity(s, before)) throw new Error("File changed before read");
    const hash = createHash("sha256");
    for await (const chunk of h.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await h.stat();
    if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("File changed while reading");
    const perms = await permissions(p);
    const final = await fs.lstat(p);
    if (!sameIdentity(after, final) || after.ctimeMs !== final.ctimeMs) throw new Error("File changed after read");
    return { dev: after.dev, ino: after.ino, ...perms, hash: hash.digest("hex"), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
  } finally { await h.close(); }
}
export async function syncDirectory(p: string) {
  if (process.platform === "win32") return; // Native MoveFileEx below requests WRITE_THROUGH.
  const h = await fs.open(p, constants.O_RDONLY); try { await h.sync(); } finally { await h.close(); }
}
export async function durableWrite(p: string, data: string | Buffer) {
  const h = await fs.open(p, "wx", 0o600);
  try { await protect(p); await h.writeFile(data); await h.sync(); } finally { await h.close(); }
  await syncDirectory(path.dirname(p));
}
/** Kernel no-replace rename; never fs.link and never copy into a visible target. */
export async function renameNoReplace(from: string, to: string) {
  if (process.platform === "win32") {
    await nativeWindowsRename(from, to, false);
  } else {
    // Node has no renameat2/renamex_np binding. Fail closed if the local runtime
    // or the filesystem cannot provide atomic no-replace (no unsafe fallback).
    const script = `import ctypes,os,sys\na=os.fsencode(sys.argv[1]);b=os.fsencode(sys.argv[2]);c=ctypes.CDLL(None,use_errno=True)\nif sys.platform=='darwin':\n r=c.renamex_np(ctypes.c_char_p(a),ctypes.c_char_p(b),ctypes.c_uint(4))\nelse:\n r=c.renameat2(-100,ctypes.c_char_p(a),-100,ctypes.c_char_p(b),ctypes.c_uint(1))\nif r: raise OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno()))`;
    await exec("python3", ["-I", "-S", "-c", script, from, to], { maxBuffer: 4096 });
    await syncDirectory(path.dirname(from));
    if (path.dirname(from) !== path.dirname(to)) await syncDirectory(path.dirname(to));
  }
}
async function nativeWindowsRename(from: string, to: string, replace: boolean) {
  await powershell(windowsMoveScript, { PI_BACKUP_FROM: from, PI_BACKUP_TO: to, PI_BACKUP_REPLACE: replace ? "true" : "false" });
}
export async function replaceJournal(from: string, to: string) {
  if (process.platform === "win32") await nativeWindowsRename(from, to, true);
  else { await fs.rename(from, to); await syncDirectory(path.dirname(to)); }
}
export async function copyPrivate(from: string, to: string, expected: { hash: string; size: number }) {
  const before = await fileState(from);
  if (!before || before.hash !== expected.hash || before.size !== expected.size) throw new Error("Source changed or invalid staged content");
  const input = await fs.open(from, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const output = await fs.open(to, "wx", 0o600);
  try {
    await protect(to);
    if (!sameIdentity(await input.stat(), before)) throw new Error("Source replaced");
    const buffer = Buffer.alloc(128 * 1024); let offset = 0;
    for (;;) { const { bytesRead } = await input.read(buffer, 0, buffer.length, offset); if (!bytesRead) break; await output.write(buffer.subarray(0, bytesRead)); offset += bytesRead; }
    await output.sync();
  } finally { await Promise.all([input.close(), output.close()]); }
  const copied = await fileState(to), after = await fileState(from);
  if (!copied || copied.hash !== expected.hash || copied.size !== expected.size || !after || !sameIdentity(before, after) || after.hash !== before.hash || after.ctimeMs !== before.ctimeMs) throw new Error("Source changed during copy");
  await syncDirectory(path.dirname(to));
  return copied;
}
