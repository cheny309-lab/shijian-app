'use strict';
importScripts('/assets/ledger-core.js','/assets/backup-core.js');
let incoming;
function readLocal(){return new Promise((resolve,reject)=>{const req=indexedDB.open('shijian_records_v2');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,data={};let tx;try{tx=db.transaction(ShijianBackup.TABLES,'readonly');for(const name of ShijianBackup.TABLES){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{data[name]=r.result;};}tx.oncomplete=()=>{db.close();resolve(data);};tx.onerror=()=>{db.close();reject(tx.error);};}catch(e){db.close();reject(e);}};});}
self.onmessage=async event=>{
    const {requestId,action}=event.data;
    try {
        if(action==='read') {
            ShijianBackup.preflight(event.data.file.size,event.data.estimate);
            self.postMessage({requestId,progress:'正在核对备份内容…'});
            const raw=JSON.parse(await event.data.file.text()); incoming=await ShijianBackup.unpack(raw);
            self.postMessage({requestId,result:{counts:Object.fromEntries(ShijianBackup.TABLES.map(t=>[t,incoming.data[t].length]))}});
        } else if(action==='plan') {
            if(!incoming)throw Error('请重新选择备份文件。');
            const local=event.data.local||await readLocal();
            const result=ShijianBackup.plan(local,incoming,event.data.choices,event.data.preferences);
            result.estimatedChangeBytes=new Blob([JSON.stringify(result.changes)]).size;
            result.estimatedRecoveryBytes=new Blob([JSON.stringify(local)]).size;
            self.postMessage({requestId,result:{...result,extensions:incoming.extensions,datasetId:incoming.datasetId}});
        } else if(action==='pack') {
            const packed=await ShijianBackup.pack(event.data.snapshot||await readLocal(),event.data.version);
            const blob=new Blob([JSON.stringify(packed)],{type:'application/json'});
            self.postMessage({requestId,result:{blob,backupId:packed.backupId,datasetId:packed.datasetId}});
        }
    }catch(error){self.postMessage({requestId,error:{code:error instanceof SyntaxError?'BACKUP_JSON':error.code||'BACKUP_FAILED',message:error instanceof SyntaxError?'这份文件暂时无法完整读取，请检查是否选中了拾间备份。':typeof error.code==='string'&&error.code.startsWith('BACKUP_')?error.message:'暂时没能完成备份处理。请保留原文件，关闭其他拾间页面后再试。'}});}
};
