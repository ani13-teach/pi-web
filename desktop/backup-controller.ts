import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BackupBridge, BackupDecision, BackupInspection, BackupProgress, BackupUiState } from "../shared/backup";
import { validateBackupUiState } from "../shared/backup-preferences";
import { scanBackup, createBackup, readArchive, planRestore, restoreBackup } from "../lib/backup/index";
import type { ScanOptions } from "../lib/backup/types";
import type { UiParticipant } from "../lib/backup/transaction";
import { BACKUP_SDK_VERSION } from "../lib/backup/runtime";
import { within } from "../lib/backup/platform";
import type { ResultOf } from "../shared/contract";

type Session = { owner: number; expires: number; file: string; inspection?: BackupInspection; key?: Buffer; mappings: Record<string,string>; fingerprint?: string };
type Scan = { owner: number; expires: number; options: ScanOptions; fingerprint: string };
type Host = {
  pickProjects(): Promise<string[] | null>; pickMapping(): Promise<string | null>; pickArchive(): Promise<string | null>; saveArchive(): Promise<string | null>;
  info(): Promise<{ agentDir:string; cwd:string }>;
  stopped<T>(work: (agentDir:string,snapshot:ResultOf<"backup.resources">) => Promise<T>):Promise<T>;
  ui: UiParticipant; homeDir: string; appVersion: string; applicationDir: string;
  progress(owner:number,progress:BackupProgress):void; freezeUi(frozen:boolean):Promise<void>;
  recoveryRequired():void;
};
export class BackupController {
  private projects = new Map<string,{owner:number;path:string;expires:number}>();
  private sessions = new Map<string,Session>(); private scans = new Map<string,Scan>();
  private operations = new Map<string,{owner:number;abort:AbortController}>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private host: Host) { this.timer=setInterval(()=>this.expire(),30_000);this.timer.unref(); }
  private expire() {
    for(const [id,s] of this.sessions) if(s.expires<Date.now()){s.key?.fill(0);this.sessions.delete(id);}
    for(const [id,s] of this.scans) if(s.expires<Date.now())this.scans.delete(id);
    for(const [id,s] of this.projects) if(s.expires<Date.now())this.projects.delete(id);
  }
  release(owner:number) {
    for(const [id,s] of this.sessions)if(s.owner===owner){s.key?.fill(0);this.sessions.delete(id);}
    for(const [id,s] of this.scans)if(s.owner===owner)this.scans.delete(id);
    for(const [id,s] of this.projects)if(s.owner===owner)this.projects.delete(id);
    for(const op of this.operations.values())if(op.owner===owner)op.abort.abort(new Error("Backup cancelled"));
  }
  private get<T extends {owner:number;expires:number}>(map:Map<string,T>,token:unknown,owner:number):T {
    this.expire();const s=typeof token==="string"?map.get(token):undefined;
    if(!s||s.owner!==owner||s.expires<Date.now())throw new Error("Backup selection expired; select it again");return s;
  }
  private password(value:unknown,exporting=false) {
    if(typeof value!=="string"||value.length<(exporting?8:1)||value.length>1024)throw new Error("A valid backup password is required");return value;
  }
  private async run<T>(owner:number,id:unknown,work:(options:Pick<ScanOptions,"signal"|"progress"|"operationId">)=>Promise<T>):Promise<T> {
    if(typeof id!=="string"||!id||id.length>128||this.operations.has(id)||this.operations.size>0)throw new Error("Another backup operation is in progress");
    const abort=new AbortController();this.operations.set(id,{owner,abort});
    try {return await work({signal:abort.signal,operationId:id,progress:p=>this.host.progress(owner,p)});}
    finally {this.operations.delete(id);}
  }
  async selectProjects(owner:number):ReturnType<BackupBridge["backupSelectProjects"]> {
    const selected=await this.host.pickProjects();if(!selected)return {cancelled:true,projects:[]};
    return {projects: selected.map(p=>{const token=randomUUID();this.projects.set(token,{owner,path:path.resolve(p),expires:Date.now()+60*60_000});return {token,label:p};})};
  }
  async scan(owner:number,input:Parameters<BackupBridge["backupScan"]>[0]):ReturnType<BackupBridge["backupScan"]> {
    if(!input||!Array.isArray(input.projectTokens)||input.projectTokens.length>32)throw new Error("Invalid backup selection");
    const projectDirs=[...new Set(input.projectTokens.map(t=>this.get(this.projects,t,owner).path))],uiState=validateBackupUiState(input.uiState);
    return this.run(owner,input.operationId,operation=>this.host.stopped(async(agentDir,snapshot)=>{
      const resourceSnapshot=snapshot.resources.filter(r=>!r.cwd||!within(r.cwd,r.path)||within(agentDir,r.path)||within(path.join(this.host.homeDir,".agents"),r.path)||projectDirs.some(p=>within(p,r.path))).map(({cwd:_cwd,...r})=>r);
      const options:ScanOptions={agentDir,homeDir:this.host.homeDir,projectDirs,resourceSnapshot,sessionDirs:snapshot.sessionDirs,resourceWarnings:snapshot.warnings,uiState,appVersion:this.host.appVersion,sdkVersion:BACKUP_SDK_VERSION,applicationDir:this.host.applicationDir};
      const preview=await scanBackup({...options,...operation}),token=randomUUID();this.scans.set(token,{owner,expires:Date.now()+10*60_000,options,fingerprint:preview.fingerprint});return {token,preview};
    }));
  }
  async export(owner:number,input:Parameters<BackupBridge["backupExport"]>[0]):ReturnType<BackupBridge["backupExport"]> {
    const password=this.password(input?.password,true);if(password!==input.confirmPassword)throw new Error("Passwords do not match");
    const scan=this.get(this.scans,input.token,owner);
    return this.run(owner,input.operationId,async operation=>{
      const outputPath=await this.host.saveArchive();operation.signal?.throwIfAborted();if(!outputPath)return {cancelled:true};
      await this.host.freezeUi(true);
      let result;
      try { result=await this.host.stopped(async(agentDir,snapshot)=>{
        if(agentDir!==scan.options.agentDir)throw new Error("Agent directory changed; scan again");
        if(JSON.stringify(validateBackupUiState(await this.host.ui.read()))!==JSON.stringify(scan.options.uiState ?? {}))throw new Error("Interface preferences changed; scan again");
        const projectDirs=scan.options.projectDirs??[];
        const additional=snapshot.resources.filter(r=>!r.cwd||!within(r.cwd,r.path)||within(agentDir,r.path)||within(path.join(this.host.homeDir,".agents"),r.path)||projectDirs.some(p=>within(p,r.path))).map(({cwd:_cwd,...r})=>r);
        const options:ScanOptions={...scan.options,resourceSnapshot:[...(scan.options.resourceSnapshot??[]),...additional],sessionDirs:[...new Set([...(scan.options.sessionDirs??[]),...snapshot.sessionDirs])],resourceWarnings:[...new Set([...(scan.options.resourceWarnings??[]),...snapshot.warnings])]};
        const fresh=await scanBackup({...options,...operation});
        if(fresh.warnings.length&&!input.acknowledgeWarnings)throw new Error("Confirm the external-resource and dependency warnings before export");
        return createBackup({...options,...operation,password,confirmPassword:input.confirmPassword,outputPath,expectedFingerprint:scan.fingerprint});
      }); } finally { await this.host.freezeUi(false); }
      this.scans.delete(input.token);return result;
    });
  }
  async inspect(owner:number,input:Parameters<BackupBridge["backupInspect"]>[0]):ReturnType<BackupBridge["backupInspect"]> {
    if(input?.kind==="select") {
      const file=await this.host.pickArchive();if(!file)return {cancelled:true};
      const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink())throw new Error("Select a regular backup file");
      const token=randomUUID();this.sessions.set(token,{owner,file,expires:Date.now()+10*60_000,mappings:Object.create(null)});return {token,name:path.basename(file)};
    }
    if(input?.kind!=="unlock")throw new Error("Invalid backup inspection");
    const s=this.get(this.sessions,input.token,owner),password=this.password(input.password);
    return this.run(owner,input.operationId,async operation=>{
      s.key?.fill(0);s.key=undefined;s.inspection=undefined;
      const decoded=await readArchive({archivePath:s.file,password,...operation});
      try {
        const info=await this.host.info();const preview=await planRestore({manifest:decoded.manifest,currentUiState:await this.host.ui.read(),agentDir:info.agentDir,homeDir:this.host.homeDir,mappings:s.mappings,signal:operation.signal});
        const {key,...inspection}=decoded;s.key=key;s.inspection=inspection;s.expires=Date.now()+10*60_000;s.fingerprint=preview.fingerprint;
        return {token:input.token,preview,legacy:inspection.legacy};
      }catch(error){decoded.key.fill(0);throw error;}
    });
  }
  async map(owner:number,input:Parameters<BackupBridge["backupSelectMappingTarget"]>[0]):ReturnType<BackupBridge["backupSelectMappingTarget"]> {
    if(this.operations.size)throw new Error("Backup operation in progress");
    const s=this.get(this.sessions,input?.token,owner),r=s.inspection?.manifest.roots.find(r=>r.id===input.rootId);
    if(!r||!["project","external"].includes(r.kind))throw new Error("Only authorized project/external roots can be remapped");
    const selected=await this.host.pickMapping();if(!selected)return {cancelled:true};
    s.mappings[r.id]=path.resolve(selected);const info=await this.host.info();
    const preview=await planRestore({manifest:s.inspection!.manifest,currentUiState:await this.host.ui.read(),agentDir:info.agentDir,homeDir:this.host.homeDir,mappings:s.mappings});s.fingerprint=preview.fingerprint;return {preview};
  }
  async restore(owner:number,input:Parameters<BackupBridge["backupRestore"]>[0]):ReturnType<BackupBridge["backupRestore"]> {
    const s=this.get(this.sessions,input?.token,owner);
    if(!s.inspection||!s.key||input.planFingerprint!==s.fingerprint||typeof input.configurationConsent!=="boolean"||!Array.isArray(input.decisions)||input.decisions.length>100000)throw new Error("Invalid restore plan; unlock the archive again");
    const decisions=input.decisions as BackupDecision[];
    for(const d of decisions)if(!d||typeof d.resourceId!=="string"||!["keep","replace"].includes(d.conflict)||!["enable","defer"].includes(d.activation))throw new Error("Invalid restore decision");
    try {return await this.run(owner,input.operationId,async operation=>{
      await this.host.freezeUi(true);
      try {return await this.host.stopped(async agentDir=>{
        try {return await restoreBackup({agentDir,homeDir:this.host.homeDir,archivePath:s.file,key:s.key,archiveHash:s.inspection!.archiveHash,mappings:s.mappings,decisions,configurationConsent:input.configurationConsent,expectedFingerprint:s.fingerprint,ui:this.host.ui,...operation});}
        catch(error){if((error as Error).message.includes("Recovery required"))this.host.recoveryRequired();throw error;}
      });}finally{await this.host.freezeUi(false);}
    });}finally{s.key?.fill(0);this.sessions.delete(input.token);}
  }
  async cancel(owner:number,input:Parameters<BackupBridge["backupCancel"]>[0]) {
    if(input?.operationId){const op=this.operations.get(input.operationId);if(op?.owner===owner)op.abort.abort(new Error("Backup cancelled"));}
    if(input?.token){const s=this.sessions.get(input.token);if(s?.owner===owner){s.key?.fill(0);this.sessions.delete(input.token);}const scan=this.scans.get(input.token);if(scan?.owner===owner)this.scans.delete(input.token);}
  }
}
