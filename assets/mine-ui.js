/* 「我的」入口与设置。数据核算、备份、反馈均通过独立模块调用。 */
(function(){'use strict';window.ShijianMine={create(d){
    const {S,C,J,DB,node,button,modal,toast,report,refresh,Journals}=d;
    const Backup=window.ShijianBackupUI.create(d),Feedback=window.ShijianFeedback.create({...d,getPage:()=>S.previousPage||S.page});
    const meta=k=>S.meta.find(m=>m.key===k)?.value;
    const section=(root,title)=>{const box=node('section','mine-section');box.append(node('h3','',title));root.append(box);return box;};
    async function toggle(key,value){await DB.put('meta',{key,value});await refresh();d.preferencesChanged?.();}
    function switchRow(root,label,value,fn){const wrap=node('label','setting-row'),text=node('span','',label),check=node('input');check.type='checkbox';check.checked=value;check.setAttribute('aria-label',label);check.addEventListener('change',async()=>{try{await fn(check.checked);}catch(e){check.checked=!check.checked;report(e);}});wrap.append(text,check);root.append(wrap);}
    async function draftBox(){
        const root=modal('草稿箱');root.append(node('p','muted','没写完也没关系。输入、编辑草稿和等待确认的日记，都留在这里。'));
        const rows=await DB.getAll('drafts');
        for(const row of rows){const box=node('div','draft-list-row');box.append(node('p','',row.kind==='composer'?'输入草稿':row.kind==='editor'?'日记编辑草稿':'反馈草稿'),node('p','muted',(row.text||row.payload?.ai||row.payload?.text||'图片或文字草稿').slice(0,80)));
            box.append(button('继续这一份',()=>{if(row.kind==='composer'){d.closeModal();void d.resumeComposer(row.id);}else if(row.kind==='editor')d.openRecord(row.recordId);else void Feedback.open();}),button('舍弃这份草稿',()=>{const body=modal('舍弃这份草稿？');body.append(node('p','muted','只移除这份未提交内容，正式日记与账单不变。'),button('确认舍弃草稿',async()=>{try{await DB.remove('drafts',row.id);if(row.kind==='composer')d.Drafts.discardComposer(row.id);await refresh();void draftBox();}catch(e){report(e);}},'danger-button'));}));root.append(box);}
        const journals=S.records.filter(r=>r.journalState==='draft'&&!r.journalDeleted);for(const r of journals)root.append(button('日记草稿 · '+J.title(r),()=>d.openRecord(r.id),'journal-list-row'));
        if(!rows.length&&!journals.length)root.append(node('p','muted','这里暂时没有草稿。'));
    }
    function exportBills(){const root=modal('导出账单');root.append(node('p','muted','文件包含真实金额，不受浏览时的隐藏开关影响。CSV用于表格查看，不能替代完整备份。'));
        const month=node('select');month.setAttribute('aria-label','导出月份');for(const [v,t]of [['','所有月份'],...Array.from(new Set(S.transactions.map(t=>(t.occurredAt||'').slice(0,7)).filter(Boolean))).sort().reverse().map(m=>[m,m])]){const o=node('option','',t);o.value=v;month.append(o);}
        const books=node('select');books.setAttribute('aria-label','导出账本');for(const b of [{id:'all',name:'全部账本'},...d.books()]){const o=node('option','',b.name);o.value=b.id;books.append(o);}
        const removed=node('input');removed.type='checkbox';const label=node('label','check-label');label.append(removed,node('span','','包含已移除账单'));root.append(month,books,label,button('确认导出真实金额 CSV',()=>{void d.exportCSV({month:month.value,book:books.value,includeDeleted:removed.checked});},'primary-button'));
    }
    async function about(which){const root=modal(which==='privacy'?'数据与隐私说明':which==='terms'?'使用说明与约定':which==='changes'?'拾间的更新':'关于拾间');
        if(which==='privacy'){
            root.append(node('p','detail-text','生活记录默认保存在此浏览器，没有云同步，也未实现应用层加密。清除网站数据或换浏览器后，不会自动找回。完整备份默认可读，请妥善保管。'));
            root.append(node('p','detail-text','开启或主动使用AI时，完成该功能所需的文字、压缩图片或所选账单信息，会经拾间服务转交智谱，通过HTTPS传输。原始图片仍留在本机；我们不承诺第三方处理后立即销毁。关闭自动处理不会撤回已经发出的请求。'));
            const link=node('a','','查看智谱的处理规则');link.href='https://docs.bigmodel.cn/cn/terms/privacy-policy';link.target='_blank';link.rel='noopener noreferrer';root.append(link);
            root.append(node('p','detail-text','反馈只上传你预览后提交的文字、截图、联系方式和限定诊断信息。接收端保留必要的处理记录；删除本机历史不等于删除后台副本。服务端可能产生必要的网络访问与错误日志，不记录生活正文到应用日志。'));
            try{const r=await fetch('/api/feedback/config'),c=await r.json();root.append(node('p','muted','维护者：'+(c.operator||'尚未配置')+'\n联系方式：'+(c.contact||'尚未配置')+'\n反馈保存期限：'+c.retentionDays+'天\n服务器区域：'+(c.region||'尚未配置；请维护者核对实际部署区域后开放反馈')));}catch(_){root.append(node('p','muted','维护者信息暂时未能读取，请稍后查看。'));}
        }else if(which==='terms')root.append(node('p','detail-text','无需注册即可使用本机记录。请只提交有权处理的资料，妥善保存备份。账单识别和生成文字可能有误，可随时核对与修改；不将生成内容当作专业财务、医疗或其他专业意见。功能、数据处理及保存边界以实际界面和数据说明为准。'),node('p','muted','这是试用版使用说明，不以模板协议宣称尚未提供的账号、加密或云同步服务。'));
        else if(which==='changes')root.append(node('p','detail-text','2026年10月27日 · V0.3.0\n完善“我的”、备份恢复、草稿、本机反馈回执与私密反馈接收。\n\nV0.2.0\n增加日记修改、最近删除、账单日记草稿选择。'));
        else root.append(node('p','detail-text','拾间，从随手留下的账单、照片和文字中，整理属于自己的生活。\n\n没有被记录的时间，也可以安心留白。这里不要求你坚持，不评判花费，只让你想留住的片段，有地方安放。'));
    }
    function render(){const root=document.getElementById('minePage');root.replaceChildren();
        const hero=node('section','mine-hero'),name=button(meta('nickname')||'拾间客',()=>{const box=modal('怎样称呼你'),input=node('input');input.maxLength=20;input.value=meta('nickname')||'';input.setAttribute('aria-label','我的昵称');input.placeholder='拾间客';box.append(input,button('留下这个称呼',async()=>{try{await toggle('nickname',input.value.trim().slice(0,20));toast('称呼已留在此浏览器。');}catch(e){report(e);}},'primary-button'));},'nickname');
        hero.append(node('span','sage-dot'),name);root.append(hero);
        const confirmed=S.transactions.filter(t=>!t.deleted&&t.status==='confirmed').length,reviews=S.transactions.filter(t=>!t.deleted&&t.status!=='confirmed').length;
        root.append(node('p','mine-counts',!S.records.some(C.onTimeline)&&!confirmed?'这里，留给你慢慢留下的生活。':`这里留着 ${S.records.filter(C.onTimeline).length} 篇时光切片，${confirmed} 笔账单记录。`));if(reviews)root.append(node('p','muted',`另有 ${reviews} 笔待核对。`));
        const state=node('section','local-state');state.append(node('strong','','保存在此浏览器 · 本机保存模式'),node('p','muted','这是拾间现阶段的保存方式，无需额外设置。换设备或换浏览器不会自动同步；清除网站数据或浏览器回收存储可能导致记录丢失。你可以导出一份完整备份。'));
        const future=node('details');future.append(node('summary','','未来的数据保存'),node('p','muted','云同步已列入后续计划；如上线，你可以自愿选择开启。现有记录不会自动上传。'));state.append(future);root.append(state);
        const records=section(root,'我的记录');records.append(button('草稿箱',()=>{void draftBox();},'mine-link'),button('最近删除 · '+S.records.filter(r=>r.journalDeleted).length,Journals.trash,'mine-link'));
        const backup=section(root,'数据与备份');backup.append(node('p','muted','完整备份包含原图与真实金额，文件未加密。请妥善保存。'));backup.append(button('导出完整备份 JSON',Backup.exportBackup,'mine-link'),button('导入恢复',Backup.openImport,'mine-link'),button('导出账单 CSV',exportBills,'mine-link'),button('导入核对记录',()=>{void Backup.conflicts();},'mine-link'),button('上次导入前的记录',()=>{void Backup.recovery().catch(report);},'mine-link'));
        if(meta('lastExport'))backup.append(node('p','muted','最近导出：'+new Date(meta('lastExport')).toLocaleString()+' · 请确认文件已下载留存。'));
        const prefs=section(root,'使用偏好');switchRow(prefs,'显示金额',!S.hideAmounts,checked=>toggle('hideAmounts',!checked));switchRow(prefs,'自动识别与整理',S.autoAI,checked=>toggle('autoAI',checked));prefs.append(node('p','muted','开启后，新记录可进行账单识别、时光整理与日月回看。每次保存仍可关闭AI；关闭开关不会撤回已发送请求。'));
        if(meta('importPauseAI'))prefs.append(node('p','muted','导入后的历史自动回看已暂停，避免重新处理旧资料。'),button('我愿意重新开启历史自动回看',()=>{const box=modal('允许整理历史记录？');box.append(node('p','muted','开启后会将已获准AI处理的历史记录与账单事实发送给配置的服务，可能产生模型费用。'),button('确认开启历史回看',async()=>{await toggle('importPauseAI',false);toast('已允许历史回看。');},'primary-button'));}));
        const feedback=section(root,'意见与反馈');feedback.append(button('留一句反馈',()=>{void Feedback.open().catch(report);},'mine-link'),button('我提交的反馈',()=>{void Feedback.history().catch(report);},'mine-link'));
        const aboutBox=section(root,'关于拾间');for(const [key,label]of [['about','主理人寄语'],['privacy','数据与隐私说明'],['terms','使用说明与约定'],['changes','版本更新记录']])aboutBox.append(button(label,()=>{void about(key);},'mine-link'));root.append(node('p','muted','拾间 · '+C.VERSION));
    }
    return{render,exportBackup:Backup.exportBackup,draftBox};
}};})();
