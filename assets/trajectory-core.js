/* 生活轨迹的纯规则：日期精度、轻汇总、可撤销来源归并；不改写原始资料。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./ledger-core'));else root.TrajectoryCore=factory(root.LedgerCore);})(typeof globalThis!=='undefined'?globalThis:this,function(C){
    'use strict';
    const Display=typeof module==='object'&&module.exports?require('./display-core'):globalThis.ShijianDisplay;
    const clean=(x,n=200)=>C.clean(x,n),key=x=>clean(x).normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    function validMonth(x){return /^\d{4}-(0[1-9]|1[0-2])$/.test(x||'')&&+x.slice(0,4)>=1900&&+x.slice(0,4)<=2200;}
    function parsePeriod(value){
        const s=clean(value,1000),full=[...s.matchAll(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日|\b)/g)].map(m=>`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`).filter(C.date);
        const days=[...new Set(full)];if(days.length===1)return days[0];if(days.length>1)return '';
        const months=[...new Set([...s.matchAll(/(\d{4})[年/.-](\d{1,2})(?:月|\b)/g)].map(m=>`${m[1]}-${m[2].padStart(2,'0')}`).filter(validMonth))];
        if(months.length!==1)return '';
        // 合并明确的年/月页头与同月行日期；“昨天”无原始时间锚点时只保留月份。
        const md=[...s.matchAll(/(?:^|[；;\s])(\d{1,2})月(\d{1,2})日/g)].filter(m=>+m[1]===+months[0].slice(5));
        if(md.length===1){const d=months[0]+'-'+md[0][2].padStart(2,'0');if(C.date(d))return d;}
        return months[0];
    }
    function period(t){if(t.dateAssigned===true)return C.date(t.trajectoryDate)?t.trajectoryDate.slice(0,10):validMonth(t.trajectoryDate)?t.trajectoryDate:'';if(C.date(t.occurredAt))return t.occurredAt.slice(0,10);return parsePeriod(t.evidence?.date||'')||parsePeriod(t.occurredAt)||parsePeriod(t.merchant);}
    function ready(t){return !['pending','closed'].includes(t.paymentState)&&(!((t.reasons||[]).includes('金额与来源摘录不一致'))||t.moneyUser===true||t.confirmation==='user')&&Number.isSafeInteger(t.amountMinor)&&t.amountMinor>=0&&t.currency in C.DIGITS&&['income','expense','refund','transfer'].includes(t.direction)&&(t.paymentState==='paid'||t.documentKind==='bill'&&t.paymentState==='unknown'||t.confirmation==='user'||t.entryMethod==='text');}
    function title(t){return Display.merchant(t);}
    function sameFields(a,b){return a.amountMinor===b.amountMinor&&a.currency===b.currency&&a.direction===b.direction&&period(a)===period(b);}
    function weak(a,b){
        if(a.keepSeparate||b.keepSeparate||!sameFields(a,b)||!period(a)||!ready(a)||!ready(b)||key(a.merchant)!==key(b.merchant)||!key(a.merchant))return false;
        if((a.sourceIds||[]).some(s=>(b.sourceIds||[]).includes(s)))return false; // 同一张图的独立行不能按同额合并。
        const da=C.date(a.occurredAt),db=C.date(b.occurredAt),time=da&&db&&da.precision==='time'&&db.precision==='time'&&Math.abs(da.timestamp-db.timestamp)<=120000;
        const identical=key(a.evidence?.amount)===key(b.evidence?.amount)&&key(a.evidence?.date)===key(b.evidence?.date)&&!!key(a.evidence?.amount)&&!!key(a.evidence?.date);
        return !!(time||identical);
    }
    function ingest(existing,candidates){const all=existing.map(t=>({...t,sourceIds:[...(t.sourceIds||[])],history:[...(t.history||[])]}));let linked=0,added=0;
        for(const t of candidates){if(all.some(x=>x.id===t.id))continue;const exact=all.find(x=>(C.sameReceipt(x,t)||((x.sourceIds||[]).some(s=>(t.sourceIds||[]).includes(s))&&x.sourceRow===t.sourceRow))&&sameFields(x,t));
            if(exact){exact.sourceIds=[...new Set([...exact.sourceIds,...t.sourceIds])];exact.history.push({at:new Date().toISOString(),action:'关联同一消费的来源'});linked++;continue;}
            all.push({...t,history:[...(t.history||[])],sourceIds:[...(t.sourceIds||[])]});added++;}
        // 沿用已明确的退款关系，不从商户名称猜原交易。
        for(const t of all.filter(x=>x.direction==='refund'&&!x.refundOf&&x.originalTransactionId&&x.provider)){const origins=all.filter(x=>!x.deleted&&x.direction==='expense'&&x.transactionId===t.originalTransactionId&&key(x.provider)===key(t.provider)&&x.currency===t.currency);if(origins.length===1){t.refundOf=origins[0].id;if(!t.bookManuallySet)t.bookId=C.bookOf(origins[0]);}}
        return {transactions:all,linked,added};
    }
    function groups(rows,{includeDeleted=false}={}){const out=[];
        for(const t of rows.filter(t=>includeDeleted?!!t.deleted:!t.deleted).sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||'')||a.id.localeCompare(b.id))){
            let g=out.find(g=>g.rows.some(x=>C.sameReceipt(x,t)||weak(x,t)));if(!g){g={id:t.id,rows:[]};out.push(g);}g.rows.push(t);}
        return out.map(g=>{const first=g.rows[0],same=g.rows.every(t=>sameFields(first,t)),dates=[...new Set(g.rows.map(period))];return {...g,row:first,sourceIds:[...new Set(g.rows.flatMap(t=>t.sourceIds||[]))],period:dates.length===1?dates[0]:'',conflict:!same,approximate:g.rows.length>1&&!g.rows.every(t=>C.sameReceipt(first,t))||g.rows.some(t=>!t.moneyUser&&(t.amountEstimated||(t.reasons||[]).includes('可见明细与来源合计不一致'))),name:title(first)};});}
    function summary(rows,month){const currencies={};let latest='',monthOnly=false,unknown=0,approximate=false;
        for(const g of groups(rows)){if(!g.period){unknown++;continue;}if(!g.period.startsWith(month))continue;if(g.period.length===7)monthOnly=true;else if(g.period>latest)latest=g.period;
            const t=g.row;if(!ready(t)||g.conflict){unknown++;continue;}approximate||=g.approximate;
            const v=currencies[t.currency]||={income:0,expense:0,refund:0,net:0,count:0,categories:{}};
            if(['income','expense','refund'].includes(t.direction)){v[t.direction]+=t.amountMinor;if(!Number.isSafeInteger(v[t.direction]))throw Error('这些记录的金额超出了本版处理范围，请保留备份。');}
            v.net=v.expense-v.refund;v.count++;if(t.direction==='expense')v.categories[t.category||'其他']=(v.categories[t.category||'其他']||0)+t.amountMinor;}
        return {currencies,latest,monthOnly,unknown,approximate};
    }
    function normalize(raw,sourceId,index,context={}){return {...C.normalize(raw,sourceId,index),trajectoryVersion:1,amountEstimated:raw?.verified?.amount===false,documentKind:context.documentKind||'bill',...(context.feeling&&context.feeling.length>8&&!/^(只记账|仅记账|识别|请识别)/.test(context.feeling)?{feeling:context.feeling.slice(0,2000)}:{}),aiAllowed:context.aiAllowed!==false};}
    function edit(t,changes,at=new Date().toISOString()){return C.edit(t,{...changes,trajectoryVersion:1,updatedAt:at},'用户修改生活轨迹');}
    function assign(t,value,at=new Date().toISOString()){if(value&&!validMonth(value)&&!/^\d{4}-\d{2}-\d{2}$/.test(value)||value&&value.length===10&&!C.date(value))throw Error('选一个有效的日期或月份，也可以留空。');return edit(t,{dateAssigned:true,trajectoryDate:value,dateOrigin:'user',dateBeforeAssignment:{dateAssigned:!!t.dateAssigned,trajectoryDate:t.trajectoryDate||'',dateOrigin:t.dateOrigin||''}},at);}
    function label(p){return p?.length===10?`${+p.slice(5,7)}月${+p.slice(8)}日`:validMonth(p)?`${+p.slice(5)}月 · 日期未注明`:'发生日期未注明';}
    function reflectionJobs(transactions,records,reflections,today=C.dayKey(),limit=6){
        const periods=new Map(),allowed=transactions.filter(t=>t.aiAllowed!==false);
        for(const g of groups(allowed).filter(g=>!g.conflict&&ready(g.row)&&g.period))for(const id of [...new Set([g.period,g.period.slice(0,7)])]){if(id.length===10?id>=today:id>=today.slice(0,7))continue;if(!periods.has(id))periods.set(id,[]);periods.get(id).push(g);}
        for(const r of records){const day=C.date(r.displayDate)?r.displayDate.slice(0,10):C.dayKey(r.time);for(const id of [day,day.slice(0,7)]){if(id.length===10?id>=today:id>=today.slice(0,7))continue;if(!periods.has(id))periods.set(id,[]);}}
        const jobs=[];for(const [id,gs]of [...periods].sort(([a],[b])=>a.length-b.length||b.localeCompare(a))){const sum=summary(gs.flatMap(g=>g.rows),id.slice(0,7)),notes=records.filter(r=>(C.date(r.displayDate)?r.displayDate.slice(0,10):C.dayKey(r.time)).startsWith(id)),facts={id,count:gs.length,recordCount:notes.length,imageRecordCount:notes.filter(r=>r.image).length,totals:Object.entries(sum.currencies).map(([currency,v])=>({currency,income:C.decimal(v.income,currency),expense:C.decimal(v.expense,currency),refund:C.decimal(v.refund,currency)})),merchants:[...new Set(gs.map(g=>g.name))].slice(0,12),notes:notes.map(r=>(r.journalEdited?r.ai:r.text)||'').filter(Boolean).slice(0,15).map(x=>x.slice(0,160))};const revision=C.digest({style:'trajectory-v040',facts,rows:gs.flatMap(g=>g.rows).map(t=>[t.id,period(t),t.amountMinor,t.category,t.feeling||''])}),old=reflections.find(r=>r.id===id);if(!old||old.revision!==revision&&old.attemptedRevision!==revision)jobs.push({...facts,revision});}
        return jobs.slice(0,limit);
    }
    return {validMonth,parsePeriod,period,ready,title,weak,ingest,groups,summary,normalize,edit,assign,label,reflectionJobs};
});
