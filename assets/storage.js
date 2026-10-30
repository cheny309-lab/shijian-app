/* IndexedDB 兼容升级：沿用稳定版数据库，旧记录与旧 localStorage 均保留。 */
(function () {
    'use strict';
    let db;
    const STORES = ['records', 'meta', 'sources', 'transactions', 'imports', 'reflections', 'drafts', 'feedbackRecords', 'conflicts'];
    const ALL_STORES = [...STORES, 'recoveries'];
    function bump(tx) { const store=tx.objectStore('meta'), req=store.get('dataRevision'); req.onsuccess=()=>store.put({key:'dataRevision',value:(req.result?.value||0)+1}); }
    function request(storeName, mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(mode === 'readwrite' ? [...new Set([storeName,'meta'])] : storeName, mode);
            let req;
            try { req = operation(tx.objectStore(storeName)); if(mode === 'readwrite') bump(tx); }
            catch (error) { tx.abort(); reject(error); return; }
            tx.oncomplete = () => resolve(req && req.result);
            tx.onerror = () => reject(tx.error || new Error('设备保存失败'));
            tx.onabort = () => reject(tx.error || new Error('设备保存中止'));
        });
    }
        function legacyRecords(items) {
            const result = [];
            let current = null;
            const finish = () => { if (current) result.push(current); current = null; };
            items.forEach((item, index) => {
                if (!item || typeof item.content !== 'string') return;
                const time = Number.isFinite(Date.parse(item.time)) ? new Date(item.time).toISOString() : new Date(0).toISOString();
                const fresh = () => ({ id: 'legacy-' + index, time, text: '', image: null, ai: '', aiStatus: 'idle', error: '', legacy: true });
                if (item.role === 'ai') {
                    if (!current) current = fresh();
                    current.ai = item.content;
                    current.aiStatus = 'done';
                    finish();
                } else {
                    const field = item.type === 'image' ? 'image' : 'text';
                    if (!current || current[field] || Math.abs(Date.parse(time) - Date.parse(current.time)) > 60000) {
                        finish(); current = fresh();
                    }
                    current[field] = item.content;
                }
            });
            finish();
            return result;
        }
        async function migrateLegacy() {
            let raw;
            try { raw = localStorage.getItem('shijian_history'); }
            catch (_) { return '旧版存储暂不可读，旧数据未删除。'; }
            if (!raw) return '';
            let legacy;
            try { legacy = JSON.parse(raw); if (!Array.isArray(legacy)) throw new Error(); }
            catch (_) { return '旧记录格式异常，已保留原数据；请先导出备份。'; }
            const records = legacyRecords(legacy);
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['records', 'meta'], 'readwrite');
                const meta = tx.objectStore('meta');
                const check = meta.get('legacy-migrated');
                check.onsuccess = () => {
                    if (check.result) return;
                    bump(tx);
                    records.forEach(record => tx.objectStore('records').put(record));
                    meta.put({ key: 'legacy-migrated', count: records.length });
                };
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('旧数据迁移未完成'));
            });
            // 原 localStorage 留存，供回退与原始备份；新记录不再写入容量很小的 localStorage。
            return '';
        }

    async function init() {
        db = await new Promise((resolve, reject) => {
            const open = indexedDB.open('shijian_records_v2', 3);
            open.onupgradeneeded = () => ALL_STORES.forEach(name => {
                if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
            });
            let blocked = false;
            open.onsuccess = () => {
                if (blocked) { open.result.close(); return; }
                open.result.onversionchange = () => { open.result.close(); window.dispatchEvent(new Event('shijian-storage-closed')); };
                resolve(open.result);
            };
            open.onerror = () => reject(open.error);
            open.onblocked = () => { blocked = true; reject(new Error('请关闭其他拾间页面后刷新。')); };
        });
        const warning = await migrateLegacy();
        if(!await get('meta','datasetId')) await put('meta',{key:'datasetId',value:crypto.randomUUID()});
        try { const raw=localStorage.getItem('shijian_history'); if(raw&&!await get('meta','backupExtensions'))await put('meta',{key:'backupExtensions',value:{legacyRaw:raw}}); } catch(_) {}
        return { warning, data: await snapshot(false) };
    }
    const getAll = name => request(name, 'readonly', store => store.getAll());
    const get = (name, id) => request(name, 'readonly', store => store.get(id));
    const put = (name, value) => request(name, 'readwrite', store => store.put(value));
    async function snapshot(includeOriginals = true) {
        const result = {};
        // 单个只读事务读取备份，避免导出过程中不同表处于不同修订。
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORES, 'readonly');
            STORES.forEach(name => {
                if (name === 'sources' && !includeOriginals) {
                    result.sources = [];
                    const req = tx.objectStore(name).openCursor();
                    req.onsuccess = () => { const cursor = req.result; if (!cursor) return; const value = cursor.value; delete value.original; result.sources.push(value); cursor.continue(); };
                } else if(!includeOriginals && ['drafts','feedbackRecords','conflicts'].includes(name)) { const outName=name==='drafts'?'savedDrafts':name;result[outName]=[]; const req=tx.objectStore(name).openCursor(); req.onsuccess=()=>{const c=req.result;if(!c)return;const row=c.value; if(name==='drafts'){delete row.images;delete row.payload;} if(name==='feedbackRecords'){delete row.queryToken;delete row.attachments;delete row.payload;} if(name==='conflicts'){delete row.local;delete row.incoming;} result[outName].push(row);c.continue();};
                } else { const req = tx.objectStore(name).getAll(); req.onsuccess = () => { result[name] = req.result; }; }
            });
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        return result;
    }
    // 一个批次的原始记录和原始文件在同一事务中保存，成功前绝不清空输入。
    function saveBatch(records, sources, draftId, quickTransaction) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['records', 'sources', 'meta', 'drafts', ...(quickTransaction ? ['transactions','imports'] : [])], 'readwrite');
            let quickResult;
            if(quickTransaction){let rows,meta,pending=2;const done=()=>{if(--pending)return;try{if(quickTransaction.manualEntry&&rows.some(r=>r.id===quickTransaction.id))throw Error('这笔已经留下，请到轨迹回看。');const candidate=window.ShijianLife?ShijianLife.apply(quickTransaction,meta):quickTransaction,merged=(window.TrajectoryCore||window.LedgerCore).ingest(rows,[candidate]);merged.transactions.forEach(row=>tx.objectStore('transactions').put(row));quickResult=merged.transactions.find(row=>row.id===quickTransaction.id);tx.objectStore('imports').put({id:quickTransaction.sourceIds[0],status:'done',documentKind:'bill',entryMethod:'text',finishedAt:new Date().toISOString(),extractedCount:1,totals:[],warnings:[],linked:merged.linked});}catch(e){reject(e);tx.abort();}};const req=tx.objectStore('transactions').getAll();req.onsuccess=()=>{rows=req.result;done();};const mr=tx.objectStore('meta').getAll();mr.onsuccess=()=>{meta=mr.result;done();};}
            bump(tx); if(draftId) tx.objectStore('drafts').delete(draftId);
            records.forEach(record => tx.objectStore('records').put(record));
            sources.forEach(source => {
                const store = tx.objectStore('sources');
                const req = store.get(source.id);
                req.onsuccess = () => {
                    const old = req.result;
                    store.put(old ? { ...old, recordIds: [...new Set([...(old.recordIds || []), ...source.recordIds])] } : source);
                };
            });
            tx.oncomplete = () => resolve(quickResult); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存中止'));
        });
    }
    // 账本读-改-写放在一个事务中；多标签页并发也不会重复累计或覆盖其他人的核对。
    function changeLedger(transform) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['transactions', 'imports', 'meta'], 'readwrite');
            bump(tx); const state = {}; let pending = 3, result;
            for (const name of ['transactions', 'imports', 'meta']) {
                const req = tx.objectStore(name).getAll();
                req.onsuccess = () => {
                    state[name] = req.result;
                    if (--pending) return;
                    try {
                        result = transform(state);
                        for (const table of ['transactions', 'imports', 'meta']) (result[table] || []).forEach(value => tx.objectStore(table).put(value));
                    } catch (error) { reject(error); tx.abort(); }
                };
            }
            tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('账本更新中止'));
        });
    }
    // 记录修改同样按最新版本合并，避免迟到的 AI 回复覆盖用户文字。
    function updateEntry(table,id,transform,expectedEpoch,allowCreate=false) {
        return new Promise((resolve,reject)=>{
            const tx=db.transaction([table,'meta'],'readwrite');let value,old,epoch,pending=expectedEpoch===undefined?1:2;
            bump(tx);
            const finish=()=>{if(--pending)return;if(!old&&!allowCreate)return;try{value=transform(old,(epoch?.value||'')!==expectedEpoch&&expectedEpoch!==undefined);if(value)tx.objectStore(table).put(value);}catch(e){reject(e);tx.abort();}};
            const req=tx.objectStore(table).get(id);req.onsuccess=()=>{old=req.result;finish();};
            if(expectedEpoch!==undefined){const r=tx.objectStore('meta').get('importEpoch');r.onsuccess=()=>{epoch=r.result;finish();};}
            tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('这次修改没有完成，请保留当前文字。'));
        });
    }
    const updateRecord=(id,transform,expectedEpoch)=>updateEntry('records',id,transform,expectedEpoch);
    const updateSource=(id,transform)=>updateEntry('sources',id,transform);
    const updateReflection=(id,transform,expectedEpoch)=>updateEntry('reflections',id,transform,expectedEpoch,true);
    // 日记草稿、发布、恢复按同一快照校验；并发标签页也不能重复发布同一笔交易。
    function changeJournals(transform) {
        return new Promise((resolve, reject) => {
            const names = ['records', 'sources', 'transactions', 'meta'], tx = db.transaction(names, 'readwrite');
            bump(tx); const state = {}; let pending = names.length, result;
            names.forEach(name => {
                const req = tx.objectStore(name).getAll();
                req.onsuccess = () => {
                    state[name] = req.result;
                    if (--pending) return;
                    try {
                        result = transform(state);
                        (result.records || []).forEach(r => tx.objectStore('records').put(r));
                        for (const source of state.sources) {
                            const related = (result.records || []).filter(r => (r.sourceIds || []).includes(source.id)).map(r => r.id);
                            if (related.length) tx.objectStore('sources').put({ ...source, recordIds: [...new Set([...(source.recordIds || []), ...related])] });
                        }
                    } catch (error) { reject(error); tx.abort(); }
                };
            });
            tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('日记保存中止'));
        });
    }
    function remove(name,id) { return request(name,'readwrite',store=>store.delete(id)); }
    function restoreBackup(plan,extensions,datasetId) {
        return new Promise((resolve,reject)=>{
            const tx=db.transaction(ALL_STORES,'readwrite'), state={};let pending=STORES.length, error;
            for(const name of STORES){const req=tx.objectStore(name).getAll();req.onsuccess=()=>{state[name]=req.result;if(--pending)return;
                try{
                    const revision=state.meta.find(m=>m.key==='dataRevision')?.value||0;
                    if(revision!==plan.baseRevision)throw Error('本机记录刚刚发生了变化，请重新预览后再恢复。');
                    tx.objectStore('recoveries').put({id:'before-last-import',at:new Date().toISOString(),data:state});
                    for(const name of STORES)(plan.changes[name]||[]).forEach(row=>tx.objectStore(name).put(row));
                    for(const c of [...plan.conflicts,...plan.suspected])tx.objectStore('conflicts').put({id:'import:'+c.ref,at:new Date().toISOString(),...c});
                    const meta=tx.objectStore('meta');meta.put({key:'dataRevision',value:revision+1});meta.put({key:'importPauseAI',value:true});meta.put({key:'importEpoch',value:crypto.randomUUID()});meta.put({key:'importTask',value:{state:'done',at:new Date().toISOString()}});
                    if(extensions&&Object.keys(extensions).length)meta.put({key:'backupExtensions',value:{...(state.meta.find(m=>m.key==='backupExtensions')?.value||{}),...extensions}});
                    if(datasetId&&(!state.records.length&&!state.transactions.length||!state.meta.some(m=>m.key==='datasetId')))meta.put({key:'datasetId',value:datasetId});
                }catch(e){error=e;tx.abort();}
            };}
            tx.oncomplete=()=>resolve();tx.onerror=()=>reject(error||tx.error);tx.onabort=()=>reject(error||tx.error||Error('这次恢复没有完成，原有记录未作更改。'));
        });
    }
    function undoBackup(){return new Promise((resolve,reject)=>{
        const tx=db.transaction(ALL_STORES,'readwrite');const state={};let pending=STORES.length+1,point,error;
        const finish=()=>{if(--pending)return;try{if(!point?.data)throw Error('还没有可恢复的导入前记录。');
            const revision=(state.meta.find(m=>m.key==='dataRevision')?.value||0)+1;
            for(const name of STORES){const store=tx.objectStore(name);store.clear();(point.data[name]||[]).forEach(row=>store.put(row));}
            tx.objectStore('meta').put({key:'dataRevision',value:revision});tx.objectStore('meta').put({key:'importPauseAI',value:true});tx.objectStore('meta').put({key:'importEpoch',value:crypto.randomUUID()});tx.objectStore('meta').put({key:'importTask',value:{state:'done'}});
            tx.objectStore('recoveries').put({id:'before-last-import',at:new Date().toISOString(),data:state});
        }catch(e){error=e;tx.abort();}};
        const req=tx.objectStore('recoveries').get('before-last-import');req.onsuccess=()=>{point=req.result;finish();};
        for(const name of STORES){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{state[name]=r.result;finish();};}
        tx.oncomplete=resolve;tx.onabort=()=>reject(error||tx.error);tx.onerror=()=>reject(error||tx.error);
    });}
    function recoveryInfo(){return request('recoveries','readonly',s=>s.get('before-last-import'));}
    window.ShijianStorage = { init, getAll, get, put, snapshot, saveBatch, changeLedger, updateRecord, updateSource, updateReflection, changeJournals, remove, restoreBackup, recoveryInfo, undoBackup };
})();
