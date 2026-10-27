/* 可迁移备份协议。纯数据规则，不执行模型请求；浏览器 Worker 与 Node 共用。 */
(function(root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./ledger-core'), require('node:crypto').webcrypto);
    else root.ShijianBackup = factory(root.LedgerCore, root.crypto);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(C, cryptoAPI) {
    'use strict';
    const TABLES = ['records','sources','transactions','imports','reflections','meta','drafts','feedbackRecords','conflicts'];
    const MAX_BYTES = 50 * 1024 * 1024;
    const internalKeys = new Set(['dataRevision','importEpoch','importPauseAI','importTask','lastExport','backupExtensions','datasetId','legacy-migrated']);
    const badKeys = new Set(['__proto__','prototype','constructor']);
    const img = s => typeof s === 'string' && /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(s);
    const stable = value => value === undefined ? 'null' : value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    const equal = (a,b) => stable(a) === stable(b);
    const sha = async s => [...new Uint8Array(await cryptoAPI.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(n => n.toString(16).padStart(2,'0')).join('');
    const fail = (code,message) => { const e = new Error(message); e.code = code; throw e; };
    const key = (table,row) => table === 'meta' ? row.key : row.id;
    function safeTree(value,depth=0,budget={n:0}) {
        if (++budget.n > 600000 || depth > 40) fail('BACKUP_COMPLEX','这份备份的内容较复杂，暂时无法恢复。原有记录未作更改。');
        if (value && typeof value === 'object') for (const k of Object.keys(value)) { if (badKeys.has(k)) fail('BACKUP_KEYS','这份文件无法安全读取，请保留原文件。'); safeTree(value[k],depth+1,budget); }
    }
    function preflight(bytes,estimate) {
        if (!Number.isSafeInteger(bytes) || bytes < 2) fail('BACKUP_EMPTY','请选择完整的拾间备份。');
        if (bytes > MAX_BYTES) fail('BACKUP_LARGE','这份备份超过本版支持的50 MB范围，暂未读取。请保留原文件；在电脑恢复的数据也不会自动同步到手机。');
        const known = estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.quota >= estimate.usage;
        // 保守的准入预算，不是设备内存测量或成功保证；提交前按实际恢复点再次检查。
        if (known && estimate.quota - estimate.usage < bytes * 3 + 1024 * 1024) fail('BACKUP_SPACE','此浏览器可用的保存空间可能不足，这次尚未开始恢复。请保留备份，腾出空间后再试。');
        if (!known && bytes > 10 * 1024 * 1024) fail('BACKUP_UNKNOWN_SPACE','暂时无法估算此浏览器的保存空间。超过10 MB的备份暂不读取，请保留文件并尝试支持空间检查的浏览器。');
        return { estimated:!!known, bytes };
    }
    function cleanMeta(rows) {
        return rows.filter(r => !internalKeys.has(r.key) && !/token|secret|password|credential|api.?key/i.test(r.key));
    }
    function feedbackArchive(row) {
        const allowed = ['id','feedbackId','text','contact','createdAt','updatedAt','status','reply','replyVersion','lastSeenReplyVersion','lastSyncedAt','attachments','archived'];
        return Object.fromEntries(allowed.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
    }
    async function pack(snapshot,appVersion,options={}) {
        const assets = new Map(), byValue = new Map();
        async function walk(value) {
            if (img(value)) {
                let assetId = byValue.get(value);
                if (!assetId) { assetId = 'sha256-' + await sha(value); byValue.set(value,assetId); const base64 = value.slice(value.indexOf(',')+1); assets.set(assetId,{ id:assetId,sha256:assetId.slice(7),mime:value.slice(5,value.indexOf(';')),bytes:base64.length*3/4-(base64.endsWith('==')?2:base64.endsWith('=')?1:0),data:value }); }
                return { $asset:assetId };
            }
            if (Array.isArray(value)) { const out=[]; for (const v of value) out.push(await walk(v)); return out; }
            if (value && typeof value==='object') { const out={}; for (const [k,v] of Object.entries(value)) { if (badKeys.has(k)) fail('BACKUP_KEYS','资料中有暂不支持的字段。'); if(['queryToken','accessToken','apiKey','adminToken','session_key','token'].includes(k))continue; out[k]=await walk(v); } return out; }
            return value;
        }
        const data={};
        for (const table of TABLES) {
            let rows=snapshot[table]||[];
            if (table==='meta') rows=cleanMeta(rows);
            if (table==='feedbackRecords') rows=rows.map(feedbackArchive);
            if(table==='imports')rows=rows.map(({token,...row})=>row);
            data[table]=await walk(rows);
        }
        data.tombstones = [...(snapshot.records||[]).filter(r=>r.journalDeleted).map(r=>({table:'records',id:r.id,deletedAt:r.deletedAt||null})),...(snapshot.transactions||[]).filter(t=>t.deleted).map(t=>({table:'transactions',id:t.id,deletedAt:t.updatedAt||null}))];
        data.assets=[...assets.values()];
        const extensions=await walk((snapshot.meta||[]).find(m=>m.key==='backupExtensions')?.value||{});
        data.assets=[...assets.values()];
        const out={format:'shijian.backup',schemaVersion:'1.0',appVersion,backupId:options.backupId||cryptoAPI.randomUUID(),datasetId:options.datasetId||(snapshot.meta||[]).find(m=>m.key==='datasetId')?.value||cryptoAPI.randomUUID(),exportedAt:options.exportedAt||new Date().toISOString(),timeZone:options.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone,manifest:{counts:Object.fromEntries(TABLES.map(t=>[t,data[t].length])),assets:assets.size},data,extensions};
        out.manifest.digest=await sha(stable({data,extensions})); return out;
    }
    function validate(data) {
        for (const table of TABLES) {
            if (!Array.isArray(data[table]) || data[table].length > 30000) fail('BACKUP_TABLE','备份里的记录格式暂时无法读取。');
            const seen=new Set();
            for (const row of data[table]) { const k=row&&key(table,row); if (!row||typeof row!=='object'||Array.isArray(row)||typeof k!=='string'||!k||k.length>1000||seen.has(k)) fail('BACKUP_ID','备份存在缺少编号或编号重复的记录，请保留原文件。'); seen.add(k); }
        }
        const sets=Object.fromEntries(TABLES.map(t=>[t,new Set(data[t].map(r=>key(t,r)))]));
        const refs=(values,set)=>{ if(values!==undefined && (!Array.isArray(values)||values.some(id=>typeof id!=='string'||!set.has(id)))) fail('BACKUP_LINK','这份备份缺少关联资料，本次未写入。请检查文件是否完整。'); };
        for (const r of data.records) {
            if(typeof r.time!=='string'||!Number.isFinite(Date.parse(r.time))) fail('BACKUP_DATE','有些日记的日期无法读取，请保留原备份。');
            for(const k of ['text','ai','title','aiCandidate']) if(r[k]!==undefined && typeof r[k]!=='string') fail('BACKUP_TEXT','有些记录的文字格式无法读取。');
            refs(r.sourceIds,sets.sources); refs(r.transactionIds,sets.transactions);
        }
        for(const s of data.sources) refs(s.recordIds,sets.records);
        for(const t of data.transactions) {
            refs(t.sourceIds,sets.sources);
            if(!Array.isArray(t.sourceIds)||!Array.isArray(t.reasons)||!Array.isArray(t.tags)||typeof t.merchant!=='string'||typeof t.currency!=='string'||typeof t.occurredAt!=='string'||!['confirmed','review','pending'].includes(t.status)) fail('BACKUP_TX','有些账单字段不完整，本次未写入。');
            if(t.amountMinor!==null && (!Number.isSafeInteger(t.amountMinor)||t.amountMinor<0)) fail('BACKUP_MONEY','有些账单金额无法核对，本次未写入。');
            if(t.status==='confirmed' && (!C.date(t.occurredAt)||!(t.currency in C.DIGITS)||t.amountMinor===null||!['income','expense','refund','transfer'].includes(t.direction))) fail('BACKUP_MONEY','有些已确认账单需要先核对金额或日期。');
            if(t.refundOf && !sets.transactions.has(t.refundOf)) fail('BACKUP_REFUND','有一笔退款缺少关联消费，本次未写入。');
        }
        for(const d of data.drafts) if(!['composer','editor','feedback'].includes(d.kind)) fail('BACKUP_DRAFT','有一份草稿暂时无法读取。');
        return data;
    }
    async function unpack(raw) {
        safeTree(raw);
        if(!raw||typeof raw!=='object'||Array.isArray(raw)) fail('BACKUP_FORMAT','暂时无法读取这份文件，请选择拾间的完整备份。');
        let data,extensions={},datasetId;
        if(raw.format==='shijian.backup') {
            if(!/^1\.\d+$/.test(raw.schemaVersion||'') || (raw.requiredFeatures||[]).length) fail('BACKUP_VERSION','这份备份需要受支持的较新拾间版本才能打开。现有记录未作更改，请先检查更新。');
            if(!raw.data||!raw.manifest||typeof raw.manifest.digest!=='string') fail('BACKUP_MANIFEST','备份的完整性说明缺失，本次未写入。');
            if(await sha(stable({data:raw.data,extensions:raw.extensions||{}}))!==raw.manifest.digest) fail('BACKUP_HASH','这份备份可能不完整或已被改动，本次未写入。请保留原文件。');
            const assets=new Map();
            for(const a of raw.data.assets||[]) {
                if(!a||!img(a.data)||a.id!=='sha256-'+await sha(a.data)||a.sha256!==a.id.slice(7)||assets.has(a.id)) fail('BACKUP_ASSET','备份中有图片无法通过完整性核对，本次未写入。');
                const encoded=a.data.slice(a.data.indexOf(',')+1),length=encoded.length*3/4-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
                if(encoded.length%4!==0||a.bytes!==length||a.mime!==a.data.slice(5,a.data.indexOf(';')))fail('BACKUP_ASSET','备份中的图片长度或格式说明不一致，本次未写入。');
                assets.set(a.id,a.data);
            }
            let expandedBytes=0;
            const budget=n=>{expandedBytes+=n;if(expandedBytes>MAX_BYTES)fail('BACKUP_EXPANSION','这份备份展开原图后超过本版50 MB的处理范围，暂未恢复。请保留文件，原有记录未作更改。');};
            function walk(v) {
                if(Array.isArray(v)) return v.map(walk);
                if(v && typeof v==='object') { if(Object.prototype.hasOwnProperty.call(v,'$asset')) { if(Object.keys(v).length!==1||!assets.has(v.$asset)) fail('BACKUP_ASSET','这份备份缺少一张来源图片，本次未写入。');const value=assets.get(v.$asset);budget(value.length);return value; } return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)])); }
                if(typeof v==='string')budget(v.length*2);
                return v;
            }
            // 资产表只作查找，不再复制展开；同一图被多处引用也计入峰值预算。
            data=walk({...raw.data,assets:[]}); extensions=walk(raw.extensions||{}); datasetId=raw.datasetId;
            for(const [k,v] of Object.entries(raw))if(!['format','schemaVersion','appVersion','backupId','datasetId','exportedAt','timeZone','manifest','data','extensions','requiredFeatures'].includes(k))extensions['root:'+k]=walk(v);
            for(const [k,v] of Object.entries(data)) if(!TABLES.includes(k)&&!['assets','tombstones'].includes(k)) extensions['data:'+k]=v;
            for(const t of data.tombstones||[]) { const row=(data[t.table]||[]).find(r=>r.id===t.id); if(!row||!['records','transactions'].includes(t.table)) fail('BACKUP_DELETE','备份的移除记录缺少关联内容。'); if(t.table==='records') row.journalDeleted=true; else row.deleted=true; }
        } else {
            if(!Array.isArray(raw.records)||!raw.version) fail('BACKUP_FORMAT','暂时无法读取这份文件，请选择拾间导出的完整备份。');
            data=Object.fromEntries(TABLES.map(t=>[t,raw[t]||[]]));
            extensions={legacyRaw:raw.legacyRaw||null};
            // 早期仅日记格式没有 sources；缺少来源字段的记录合法，已有来源引用不能伪造。
        }
        for(const t of TABLES) if(data[t]===undefined) data[t]=[];
        data.meta=cleanMeta(data.meta);
        data.feedbackRecords=data.feedbackRecords.map(r=>({...feedbackArchive(r),archived:true}));
        validate(data);
        return {data:Object.fromEntries(TABLES.map(t=>[t,data[t]])),extensions,datasetId};
    }
    function comparable(row) {
        const r={...row}; for(const k of ['token','statusBeforeImport']) delete r[k];
        if(['running','generating','queued'].includes(r.status)) r.status='interrupted';
        if(['running','generating','queued'].includes(r.aiStatus)) r.aiStatus='idle';
        return r;
    }
    function plan(local,incoming,choices={},preferences=false) {
        const changes=Object.fromEntries(TABLES.map(t=>[t,[]])), conflicts=[],suspected=[],skipped=[];
        for(const source of incoming.data.sources){
            const old=(local.sources||[]).find(s=>s.id===source.id);
            if(old && ((old.original&&source.original&&old.original!==source.original)||(old.text&&source.text&&old.text!==source.text)))fail('BACKUP_SOURCE_COLLISION','这份备份有资料编号与本机相同，但原始内容不同。为保留真实来源，本版暂不合并；可在空浏览器中恢复，原文件和本机记录均保留。');
        }
        const txMap=new Map();
        for(const t of incoming.data.transactions) { const same=(local.transactions||[]).find(x=>x.id!==t.id&&!x.deleted&&C.sameReceipt(x,t)&&x.amountMinor===t.amountMinor&&x.currency===t.currency&&x.occurredAt===t.occurredAt); if(same) txMap.set(t.id,same.id); }
        function normalize(table,row) {
            let out={...row};
            if(table==='records') { if(['generating','queued'].includes(out.aiStatus)) out.aiStatus='idle'; if(out.transactionIds) out.transactionIds=out.transactionIds.map(id=>txMap.get(id)||id); }
            if(table==='transactions'&&out.refundOf) out.refundOf=txMap.get(out.refundOf)||out.refundOf;
            if(table==='imports') { delete out.token; if(out.status==='running') {out.status='interrupted';out.error='历史整理未完成，未自动重试。';} }
            if(table==='reflections'&&out.status==='running') out.status='interrupted';
            return out;
        }
        for(const table of TABLES) for(const raw of incoming.data[table]) {
            const row=normalize(table,raw), k=key(table,row), ref=table+':'+k, old=(local[table]||[]).find(r=>key(table,r)===k);
            if(table==='meta'&&(k==='autoAI'||['hideAmounts','nickname'].includes(k)&&!preferences)) {skipped.push(ref);continue;}
            if(table==='transactions'&&txMap.has(k)) {
                const oldTx=local.transactions.find(t=>t.id===txMap.get(k));
                changes.transactions.push({...oldTx,sourceIds:[...new Set([...oldTx.sourceIds,...row.sourceIds])]}); skipped.push(ref);continue;
            }
            if(old && equal(comparable(old),comparable(row))) {skipped.push(ref);continue;}
            if(old && table==='sources' && equal({...old,recordIds:[]},{...row,recordIds:[]})) {changes.sources.push({...old,recordIds:[...new Set([...(old.recordIds||[]),...(row.recordIds||[])])]});continue;}
            if(old) {
                const conflict={ref,table,key:k,local:old,incoming:row};conflicts.push(conflict);
                if(choices[ref]!=='incoming') continue;
            } else if(table==='records') {
                const match=(local.records||[]).find(r=>!r.journalDeleted&&C.dayKey(r.time)===C.dayKey(row.time)&&((r.text&&r.text===row.text)||(r.image&&r.image===row.image)));
                if(match) {suspected.push({ref,table,key:k,local:match,incoming:row});if(choices[ref]!=='incoming')continue;}
            }
            if(table==='transactions'&&!old) {
                const near=(local.transactions||[]).find(t=>C.possibleDuplicate(t,row));
                if(near) {row.status='review';row.confirmation='';row.duplicateOf=near.id;row.reasons=[...new Set([...(row.reasons||[]),'导入记录可能与本机交易重复，请核对'])];}
            }
            changes[table].push(row);
        }
        // 合并跨来源交易时，多个候选的来源须累加，不能由最后一项覆盖。
        const txChanges=new Map();for(const row of changes.transactions){const prior=txChanges.get(row.id);txChanges.set(row.id,prior?{...row,sourceIds:[...new Set([...prior.sourceIds,...row.sourceIds])]}:row);}changes.transactions=[...txChanges.values()];
        const combined=Object.fromEntries(TABLES.map(t=>{const map=new Map((local[t]||[]).map(r=>[key(t,r),r]));changes[t].forEach(r=>map.set(key(t,r),r));return[t,[...map.values()]];}));
        // 未选入的日记不应留成来源反向悬空引用；来源正向引用不可偷偷删除。
        const recordIds=new Set(combined.records.map(r=>r.id));
        changes.sources=changes.sources.map(s=>({...s,recordIds:(s.recordIds||[]).filter(id=>recordIds.has(id))}));
        combined.sources=combined.sources.map(s=>changes.sources.find(r=>r.id===s.id)||s);
        validate(combined);
        return {changes,conflicts,suspected,skipped,baseRevision:(local.meta||[]).find(m=>m.key==='dataRevision')?.value||0,counts:Object.fromEntries(TABLES.map(t=>[t,changes[t].length]))};
    }
    return {TABLES,MAX_BYTES,stable,equal,sha,img,preflight,pack,unpack,plan,validate,cleanMeta,feedbackArchive};
});
