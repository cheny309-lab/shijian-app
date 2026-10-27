/* 私密反馈与本机回执。仅用户主动打开时查询；不读取生活数据表。 */
(function(){'use strict';window.ShijianFeedback={create(d){
    const {DB,C,node,button,modal,toast,report}=d;let config;
    const api=async(path,body)=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);try{const r=await fetch('/api/feedback/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:controller.signal});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error?.message||'暂时没有收到处理结果，内容仍留在此设备。'),{code:data.error?.code});return data;}catch(e){if(e.name==='AbortError'||e instanceof TypeError||e instanceof SyntaxError)throw Error('暂时没有收到处理结果，反馈内容仍留在此设备。可以稍后查看提交记录。');throw e;}finally{clearTimeout(timer);}};
    const getConfig=async()=>{config=await api('config');return config;};
    const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
    const statusLabel=r=>r.archived?'本地反馈存档':({draft:'尚未提交',uncertain:'提交结果待确认',pending:'待查看',working:'处理中',replied:'已回复',resolved:'已解决',expired:'已不存在或超过保存期限',deleted:'后台反馈已删除'}[r.status]||'已提交');
    async function send(row){const data=await api('submit',row.payload);const next={...row,...data,id:row.id,feedbackId:data.id,lastSyncedAt:new Date().toISOString()};await DB.put('feedbackRecords',next);await DB.remove('drafts','feedback-composer');return next;}
    async function compress(file){
        if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>12*1024*1024)throw Error('请选择12 MB以内的普通截图。');
        const url=URL.createObjectURL(file);try{return await new Promise((resolve,reject)=>{const img=new Image();img.onerror=()=>reject(Error('这张截图暂时无法读取。'));img.onload=()=>{const scale=Math.min(1,1400/img.width,1800/img.height),c=document.createElement('canvas');c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);const data=c.toDataURL('image/jpeg',.8);data.length>850000?reject(Error('截图处理后仍较大，请先裁剪到需要反馈的部分。')):resolve({name:file.name.slice(0,80),data});};img.src=url;});}finally{URL.revokeObjectURL(url);}}
    async function open(){
        const root=modal('把这句话交给拾间'),note=node('p','muted','哪里不太顺手，或者你希望拾间多懂一点什么？');root.append(note);
        const saved=await DB.get('drafts','feedback-composer'),text=node('textarea','journal-editor');text.maxLength=3000;text.value=saved?.text||'';text.setAttribute('aria-label','反馈内容');root.append(text);
        const contact=node('input');contact.maxLength=120;contact.value=saved?.contact||'';contact.placeholder='微信号或其他联系方式（可不填）';contact.setAttribute('aria-label','反馈联系方式');root.append(contact);
        const page=node('select');page.setAttribute('aria-label','反馈来自页面');for(const [value,label]of [['timeline','时光'],['bills','账单'],['mine','我的'],['other','其他']]){const o=node('option','',label);o.value=value;page.append(o);}page.value=d.getPage()||'mine';
        root.append(node('p','detail-label','问题发生在哪里'),page);
        let finished=false;let attachments=saved?.attachments||[],lastAttempt=saved?.attemptId?await DB.get('feedbackRecords',saved.attemptId):null;
        const images=node('div','feedback-images'),pick=node('input');pick.type='file';pick.accept='image/png,image/jpeg,image/webp';pick.setAttribute('aria-label','添加反馈截图');root.append(node('p','muted','截图可不加；请先遮住私人内容。最多2张，仅你选择的截图会发送。'),pick,images);
        const status=node('p','form-error');status.setAttribute('role','status');root.append(status);
        const preview=node('details','reflection');preview.append(node('summary','','查看将发送的信息'));const content=node('div');preview.append(content);root.append(preview);
        function payload(){return{text:text.value,contact:contact.value,attachments,diagnostics:{version:C.VERSION,page:page.value,errorCode:d.getErrorCode()||''}};}
        async function saveDraft(){if(finished)return;try{await DB.put('drafts',{id:'feedback-composer',kind:'feedback',text:text.value,contact:contact.value,attachments,attemptId:lastAttempt?.id||null,updatedAt:new Date().toISOString()});}catch(_){status.textContent='反馈暂时没能保存，请先复制文字留存。';}}
        function draw(){images.replaceChildren();attachments.forEach((a,i)=>{const box=node('div'),img=node('img');img.src=a.data;img.alt='你选择的反馈截图';box.append(img,button('移除截图',()=>{attachments.splice(i,1);draw();void saveDraft();}));images.append(box);});content.replaceChildren(node('p','detail-text','反馈文字：'+(text.value||'尚未填写')),node('p','detail-text','联系方式：'+(contact.value||'无')),node('p','muted',`当前版本：${C.VERSION}\n来自页面：${page.options[page.selectedIndex].textContent}\n错误代码：${d.getErrorCode()||'无'}\n附加截图：${attachments.length} 张`));attachments.forEach(a=>{const img=node('img','feedback-preview');img.src=a.data;img.alt='将发送的截图';content.append(img);});}
        root.append(node('p','muted','系统不会自动读取或附带你的日记、账单明细、金额及原图。你在这里主动填写的文字、上传的截图和联系方式，会随反馈发送。'));
        let timer;window.addEventListener('shijian-modal-close',()=>{clearTimeout(timer);void saveDraft();},{once:true});
        for(const e of [text,contact,page])e.addEventListener('input',()=>{draw();clearTimeout(timer);timer=setTimeout(()=>{void saveDraft();},700);});
        pick.addEventListener('change',async()=>{const file=pick.files?.[0];pick.value='';if(!file)return;if(attachments.length>=2){status.textContent='最多添加2张截图。';return;}try{attachments.push(await compress(file));draw();await saveDraft();}catch(e){status.textContent=e.message;}});draw();
        const submit=button('把这句话交给拾间',async()=>{
            if(!text.value.trim()){status.textContent='先留下一句话，就可以。';return;}submit.disabled=true;clearTimeout(timer);await saveDraft();
            try{
                if(!config?.enabled)throw Error('反馈接收暂未开放，可以先保存在此设备或复制给维护者。');
                if(lastAttempt)throw Error('这条反馈的提交结果待确认，请先到“我提交的反馈”核对，再另写新反馈。');
                const clientSubmissionId='fb-'+crypto.randomUUID(),queryToken=token(),p={...payload(),clientSubmissionId,queryToken};
                const row={id:clientSubmissionId,clientSubmissionId,queryToken,text:p.text,contact:p.contact,attachments:p.attachments,payload:p,status:'uncertain',createdAt:new Date().toISOString()};await DB.put('feedbackRecords',row);lastAttempt=row;await saveDraft();
                const sent=await send(row);finished=true;root.append(button('再留一句反馈',()=>{void open();}));status.textContent='已经收到。反馈编号：'+sent.feedbackId;submit.disabled=true;
            }catch(e){status.textContent=e.message;submit.disabled=false;}
        },'primary-button');root.append(submit,button('我提交的反馈',()=>{void history();}),button('复制反馈内容',async()=>{try{await navigator.clipboard.writeText(text.value);toast('已复制文字，可自行交给维护者。');}catch(_){status.textContent='可以长按选择文字并复制。';}}));
        try{const c=await getConfig();if(!root.isConnected)return;submit.disabled=!c.enabled;root.append(node('p','muted',c.enabled?`反馈及附件在接收端最多保留 ${c.retentionDays} 天。${c.contact?'联系与删除请求：'+c.contact:''}`:'集中反馈暂未开放；本机草稿和复制入口仍可使用。'));}catch(e){submit.disabled=true;status.textContent=e.message;}
    }
    async function history(){
        const root=modal('我提交的反馈');root.append(node('p','muted','反馈回执留在此浏览器。换设备或清除网站数据后，不会自动找回查询资格。'));const list=node('div'),status=node('p','muted');root.append(status,list);
        async function draw(update){
            const rows=(await DB.getAll('feedbackRecords')).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));list.replaceChildren();if(!rows.length)list.append(node('p','muted','这里还没有提交记录。'));
            for(let row of rows){let error='';if(update&&row.queryToken&&!row.archived&&row.status!=='deleted')try{const latest=await api('lookup',{clientSubmissionId:row.clientSubmissionId,queryToken:row.queryToken});row={...row,...latest,id:row.id,feedbackId:latest.id,lastSyncedAt:new Date().toISOString()};await DB.put('feedbackRecords',row);}catch(e){error=e.message;if(e.code==='FEEDBACK_NOT_FOUND'&&row.status!=='uncertain'){row={...row,status:'expired'};await DB.put('feedbackRecords',row);}}
                if(!root.isConnected)return;const item=node('details','reflection'),unread=(row.replyVersion||0)>(row.lastSeenReplyVersion||0);item.append(node('summary','',statusLabel(row)+(unread?' · ● 有新回复':'')),node('p','detail-text',row.text),node('p','muted',new Date(row.createdAt).toLocaleString()+'\n反馈编号：'+(row.feedbackId||'等待确认')));
                if(row.reply)item.append(node('p','detail-label','拾间的回复'),node('p','detail-text',row.reply));if(row.lastSyncedAt)item.append(node('p','muted','上次查看：'+new Date(row.lastSyncedAt).toLocaleString()));if(error)item.append(node('p','muted',error));
                item.addEventListener('toggle',()=>{if(item.open&&unread){void DB.put('feedbackRecords',{...row,lastSeenReplyVersion:row.replyVersion}).catch(report);}});
                if(row.status==='uncertain'&&row.payload)item.append(button('核对后重试这一次提交',async()=>{try{await send(row);await draw(false);}catch(e){toast(e.message);}}));
                if(row.queryToken&&!row.archived&&row.status!=='deleted')item.append(button('申请删除后台这条反馈',()=>{const body=modal('删除后台反馈？');body.append(node('p','muted','会从接收端移除反馈文字、联系方式与附件。本机回执保留；维护者已经另行保存的副本不由此操作控制。'),button('确认删除这条后台反馈',async()=>{try{await api('delete',{clientSubmissionId:row.clientSubmissionId,queryToken:row.queryToken});await DB.put('feedbackRecords',{...row,status:'deleted',payload:undefined});toast('后台反馈已删除。');void history();}catch(e){report(e);}},'danger-button'));}));
                list.append(item);
            }
        }
        root.append(button('更新回复',()=>{void draw(true).catch(report);}));await draw(false);await draw(true);
    }
    return{open,history};
}};})();
