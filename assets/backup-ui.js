/* 备份交互：读取前预检、Worker 校验、只读预览与原子提交。 */
(function(){'use strict';window.ShijianBackupUI={create(d){
    const {DB,C,S,node,button,modal,toast,report,refresh,download}=d,B=window.ShijianBackup;
    let busy=false;
    function workerClient(){
        if(!window.Worker)throw Error('这个浏览器暂不支持安全读取备份，请保留文件并换用较新的浏览器。');
        const worker=new Worker('/assets/backup-worker.js'),pending=new Map();let seq=0;
        const stop=()=>{worker.terminate();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('这次操作已停止，原有记录未作更改。'));}pending.clear();};
        worker.onmessage=({data})=>{const p=pending.get(data.requestId);if(!p)return;if(data.progress){p.progress?.(data.progress);return;}clearTimeout(p.timer);pending.delete(data.requestId);data.error?p.reject(Object.assign(Error(data.error.message),{code:data.error.code})):p.resolve(data.result);};
        worker.onerror=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('这次没能读完备份，原有记录未作更改。请保留文件，换用电脑浏览器再试。'));}pending.clear();worker.terminate();};
        return{stop,call:(action,args={},progress)=>new Promise((resolve,reject)=>{const requestId=++seq,timer=setTimeout(()=>{pending.delete(requestId);reject(Error('这次读取时间较长，已停止。请保留原文件，稍后再试。'));stop();},180000);pending.set(requestId,{resolve,reject,timer,progress});worker.postMessage({action,requestId,...args});})};
    }
    function message(error){if(error?.name==='QuotaExceededError')return '这次恢复没有完成，原有记录未作更改。此浏览器的保存空间不足，请保留备份并释放空间后再试。';if(['AbortError','UnknownError','DataCloneError','TransactionInactiveError','InvalidStateError'].includes(error?.name))return '这次操作没有完成，请保留备份文件，关闭其他拾间页面后再试。';return error?.message||'这次操作暂时没有完成，请保留原文件。';}
    async function estimate(){try{return await navigator.storage?.estimate?.();}catch(_){return null;}}
    async function exportBackup(){if(busy){toast('上一份备份还在整理，请稍等。');return;}busy=true;let client;try{
        client=workerClient();const result=await client.call('pack',{version:C.VERSION});
        const date=new Date(),stamp=C.dayKey().replaceAll('-','')+'_'+[date.getHours(),date.getMinutes(),date.getSeconds()].map(n=>String(n).padStart(2,'0')).join('');
        await DB.put('meta',{key:'lastBackupPrepared',value:new Date().toISOString()});await refresh();d.Files.present(result.blob,'shijian_backup_'+stamp+'.json',{backup:true,onConfirmed:async()=>{await DB.put('meta',{key:'lastBackupConfirmed',value:new Date().toISOString()});await refresh();}});
    }catch(e){report(e);}finally{client?.stop();busy=false;}}
    function openImport(){
        const root=modal('把生活带回来');root.append(node('p','muted','选择拾间的完整备份（JSON或备份文本TXT）。先核对，再由你决定；预览不会改动现有记录，也不会发送给AI。'));
        const file=node('input');file.type='file';file.accept='.json,.txt,application/json,text/plain';file.setAttribute('aria-label','选择完整备份');root.append(file);
        const status=node('p','muted');status.setAttribute('role','status');root.append(status);let client,plan,choices={},incomingFile,commitButton,finished=false,committing=false,generation=0;
        const pref=node('input');pref.type='checkbox';pref.setAttribute('aria-label','恢复昵称与金额显示偏好');const prefLabel=node('label','check-label');prefLabel.append(pref,node('span','','同时恢复昵称与金额显示偏好（不会自动开启AI）'));root.append(prefLabel);pref.addEventListener('change',()=>{if(commitButton)commitButton.disabled=true;status.textContent='选择已改变，请先重新预览。';});
        const detail=node('div');root.append(detail);
        window.addEventListener('shijian-modal-close',()=>{generation++;client?.stop();if(!finished&&!committing)void DB.put('meta',{key:'importTask',value:{state:'cancelled'}}).catch(()=>{});},{once:true});
        const cancel=button('停止并保留原记录',()=>{if(finished){d.closeModal();return;}if(committing)return;generation++;client?.stop();void DB.put('meta',{key:'importTask',value:{state:'cancelled'}}).catch(()=>{});status.textContent='已停止，原有记录未作更改。';detail.replaceChildren();plan=null;});root.append(cancel);
        async function preview(){
            if(committing||finished)return;if(commitButton)commitButton.disabled=true;
            status.textContent='正在与本机记录核对…';
            const nextPlan=await client.call('plan',{choices,preferences:pref.checked});
            if(!root.isConnected||finished||committing)return;plan=nextPlan;detail.replaceChildren();status.textContent='已核对完成，尚未写入。';
            const total=Object.values(plan.counts).reduce((a,b)=>a+b,0);detail.append(node('p','detail-text',`将新增或更新 ${total} 项，跳过 ${plan.skipped.length} 项，内容冲突 ${plan.conflicts.length} 项，可能重复 ${plan.suspected.length} 组。`));
            const labels={records:'日记',sources:'来源资料',transactions:'账单',imports:'识别说明',reflections:'生活回看',meta:'设置',drafts:'草稿',feedbackRecords:'反馈存档',conflicts:'核对历史'};
            detail.append(node('p','muted',Object.entries(plan.counts).filter(([,n])=>n).map(([t,n])=>labels[t]+' '+n).join(' · ')||'没有新增内容。'));
            for(const conflict of [...plan.conflicts,...plan.suspected]){
                const section=node('details','reflection');section.append(node('summary','',labels[conflict.table]+' · '+(conflict.incoming.title||conflict.incoming.merchant||conflict.incoming.name||'内容需要你选择')));
                const describe=x=>[x.title,x.text,x.ai,x.merchant,x.occurredAt,Number.isSafeInteger(x.amountMinor)?(S.hideAmounts?'金额已隐藏':x.currency+' '+C.decimal(x.amountMinor,x.currency)):null,x.direction,x.status,x.journalDeleted?'已移入最近删除':'',x.deleted?'已从账本移除':''].filter(Boolean).join('\n').slice(0,1500);
                section.append(node('p','detail-label','本机保留的内容'),node('p','detail-text',describe(conflict.local)||'已有资料或设置'),node('p','detail-label','备份中的内容'),node('p','detail-text',describe(conflict.incoming)||'备份资料或设置'));
                if(conflict.table==='transactions'){section.append(node('p','muted','账单金额或状态可能不同。采用备份后会重算累计，另一版本留在核对历史中。'));if(S.hideAmounts)section.append(button('查看这组真实金额',()=>{section.append(node('p','detail-text','本机：'+conflict.local.currency+' '+C.decimal(conflict.local.amountMinor,conflict.local.currency)+'\n备份：'+conflict.incoming.currency+' '+C.decimal(conflict.incoming.amountMinor,conflict.incoming.currency)));}));}
                const select=node('select');select.setAttribute('aria-label','恢复选择 '+conflict.ref);
                for(const [value,label]of [['local','保留本机内容'],['incoming',plan.suspected.includes(conflict)?'这也是一条独立记录，一起保留':'采用备份版本']]){const o=node('option','',label);o.value=value;select.append(o);}select.value=choices[conflict.ref]||'local';
                select.addEventListener('change',()=>{choices[conflict.ref]=select.value;status.textContent='选择已改变，请先重新预览。';commit.disabled=true;});section.append(select);detail.append(section);
            }
            detail.append(node('p','muted','默认保留本机的AI及显示偏好；旧任务不会自动重跑。冲突版本会保存在“导入核对记录”。'));
            detail.append(button('按选择重新预览',()=>{void preview().catch(e=>{status.textContent=message(e);});}));
            const commit=button('确认恢复这些记录',async()=>{
                commit.disabled=true;committing=true;file.disabled=true;cancel.disabled=true;
                try{const est=await estimate(),bytes=plan.estimatedChangeBytes;B.preflight(Math.max(2,Math.min(incomingFile.size,B.MAX_BYTES)),est);if(est&&est.quota-est.usage<bytes+plan.estimatedRecoveryBytes+1024*1024)throw Error('此浏览器暂时没有足够空间保留恢复点，本次未写入。请保留备份文件。');
                    await DB.restoreBackup(plan,plan.extensions,plan.datasetId);finished=true;cancel.textContent='关闭';client.stop();plan=null;await refresh();status.textContent='恢复已完成。记录留在此浏览器，历史AI处理仍暂停。';detail.replaceChildren();file.value='';toast('生活记录已带回此浏览器。');
                }catch(e){status.textContent=message(e);commit.disabled=false;}finally{committing=false;file.disabled=false;cancel.disabled=false;}
            },'primary-button');commitButton=commit;detail.append(commit);
        }
        file.addEventListener('change',async()=>{
            const currentGeneration=++generation;finished=false;cancel.textContent='停止并保留原记录';client?.stop();plan=null;choices={};detail.replaceChildren();incomingFile=file.files?.[0];if(!incomingFile)return;
            try{
                const est=await estimate();if(currentGeneration!==generation)return;B.preflight(incomingFile.size,est);
                status.textContent=est?'正在核对这份备份…':'暂时无法估算保存空间，将按较小文件范围核对。';
                client=workerClient();await DB.put('meta',{key:'importTask',value:{state:'reading',at:new Date().toISOString()}});if(currentGeneration!==generation)return;
                await client.call('read',{file:incomingFile,estimate:est},text=>{if(currentGeneration===generation)status.textContent=text;});if(currentGeneration!==generation)return;await preview();
            }catch(e){if(currentGeneration!==generation)return;client?.stop();void DB.put('meta',{key:'importTask',value:{state:'failed'}}).catch(()=>{});status.textContent=message(e);if(e.code==='BACKUP_LARGE')detail.append(node('p','muted','本版50 MB为保守上限，并非所有手机的安全保证。在电脑恢复的记录只留在电脑浏览器，不会自动同步回手机。'));}
        });
    }
    async function recovery(){
        const point=await DB.recoveryInfo();const root=modal('上次导入前的记录');if(!point){root.append(node('p','muted','还没有导入恢复点。'));return;}
        root.append(node('p','detail-text','保留于 '+new Date(point.at).toLocaleString()+'。恢复会替换当前本机记录；当前内容会交换保存为另一份恢复点，不会上传。建议先导出当前完整备份。'));
        root.append(button('先导出当前备份',exportBackup),button('确认切换到这份恢复点',async()=>{try{await DB.undoBackup();await refresh();root.replaceChildren(node('p','muted','已切换完成。另一份内容仍在恢复点中，历史AI处理暂停。'));}catch(e){report(e);}},'danger-button'));
    }
    async function conflicts(){const root=modal('导入核对记录'),rows=await DB.getAll('conflicts');if(!rows.length)root.append(node('p','muted','这里还没有导入冲突。'));for(const row of rows){const box=node('details','reflection');box.append(node('summary','',row.table+' · '+new Date(row.at).toLocaleString()));for(const [label,x]of [['本机版本',row.local],['备份版本',row.incoming]])box.append(node('p','detail-label',label),node('p','detail-text',[x?.title,x?.text,x?.ai,x?.merchant,x?.occurredAt].filter(Boolean).join('\n')||'设置或资料版本已保留。'));root.append(box);}}
    return{exportBackup,openImport,recovery,conflicts};
}};})();
