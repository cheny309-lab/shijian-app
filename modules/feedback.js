/* 私密反馈：单实例磁盘存储、原子替换；无后台日记访问能力。 */
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),express=require('express');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const validToken=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
function secureEqual(a,b){const x=Buffer.from(hash(String(a||''))),y=Buffer.from(hash(String(b||'')));return crypto.timingSafeEqual(x,y);}
function createFeedback({dataDir='',adminToken='',retentionDays=90,contact='',operator='',region='',clock=Date.now,logger=console}={}){
    const router=express.Router(),enabled=path.isAbsolute(dataDir)&&adminToken.length>=32&&!!contact&&!!operator&&!!region&&!path.resolve(dataDir).startsWith(path.resolve(__dirname,'../assets'));
    let queue=Promise.resolve(),ready;
    const file=enabled?path.join(dataDir,'feedback-v1.json'):'';
    const days=Math.max(7,Math.min(365,Number(retentionDays)||90));
    const config={enabled,retentionDays:days,contact:String(contact).slice(0,200),operator:String(operator).slice(0,100),region:String(region).slice(0,100)};
    const init=()=>ready||(ready=(async()=>{await fs.mkdir(dataDir,{recursive:true,mode:0o700});try{await fs.access(file);}catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(file,JSON.stringify({version:1,items:[]}),{mode:0o600,flag:'wx'});}})());
    const exclusive=work=>{const task=queue.then(async()=>{await init();const state=JSON.parse(await fs.readFile(file,'utf8'));if(!state||state.version!==1||!Array.isArray(state.items))throw Error('STORE_INVALID');const result=await work(state);if(result.write){const temp=file+'.'+crypto.randomUUID()+'.tmp';let handle;try{handle=await fs.open(temp,'wx',0o600);const body=JSON.stringify(state);if(Buffer.byteLength(body)>32*1024*1024)throw Object.assign(Error('反馈箱暂时已满，请稍后再试。'),{status:507,code:'FEEDBACK_FULL'});await handle.writeFile(body);await handle.sync();await handle.close();handle=null;await fs.rename(temp,file);}finally{if(handle)await handle.close();await fs.rm(temp,{force:true}).catch(()=>{});}}return result.value;});queue=task.catch(()=>{});return task;};
    const rate=new Map();
    router.use((req,res,next)=>{
        res.set('Cache-Control','no-store');
        if(req.path==='/config')return next();
        if(!enabled)return res.status(503).json({error:{code:'FEEDBACK_UNAVAILABLE',message:'反馈接收暂未开放，文字可先保存在此设备。'}});
        const address=req.socket.remoteAddress||'',k=hash(address),now=clock();let r=rate.get(k);if(!r||now-r.at>60000){r={at:now,n:0};rate.set(k,r);}if(rate.size>5000)for(const [key,value]of rate)if(now-value.at>60000)rate.delete(key);
        if(++r.n>100)return res.status(429).json({error:{code:'FEEDBACK_RATE',message:'刚才操作较多，请稍等一会再试。'}});next();
    });
    const publicRow=row=>({id:row.id,text:row.text,createdAt:row.createdAt,status:row.status,reply:row.reply||'',replyVersion:row.replyVersion||0,updatedAt:row.updatedAt});
    const route=(pattern,handler)=>router.post(pattern,async(req,res)=>{try{res.json(await handler(req));}catch(e){const status=e.status||503;if(status===503)logger.error('feedback-store-error');res.status(status).json({error:{code:e.code||'FEEDBACK_FAILED',message:e.status?e.message:'反馈暂时没有处理完成，内容仍可留在此设备。'}});}});
    const invalid=(message,status=400,code='FEEDBACK_INPUT')=>{const e=Error(message);e.status=status;e.code=code;throw e;};
    const admin=req=>{const token=(req.get('authorization')||'').replace(/^Bearer /,'');if(!secureEqual(token,adminToken))invalid('管理凭证未通过验证。',401,'ADMIN_AUTH');};
    function attachment(a){
        if(!a||typeof a.data!=='string'||a.data.length>900000||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(a.data))invalid('截图格式或大小不支持，请重新选择。');
        const bytes=Buffer.from(a.data.split(',')[1],'base64');const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
        if(!(png||jpg))invalid('这张截图暂时无法读取。');return{name:String(a.name||'反馈截图').slice(0,80),data:a.data};
    }
    router.get('/config',(req,res)=>res.json(config));
    route('/submit',async req=>{
        const b=req.body||{};
        const allowed=['clientSubmissionId','queryToken','text','contact','attachments','diagnostics'];
        if(Object.keys(b).some(k=>!allowed.includes(k))||!validToken(b.queryToken)||typeof b.clientSubmissionId!=='string'||!/^fb-[a-f0-9-]{16,80}$/.test(b.clientSubmissionId)||typeof b.text!=='string'||!b.text.trim()||b.text.length>3000||typeof b.contact!=='string'||b.contact.length>120||!Array.isArray(b.attachments)||b.attachments.length>2)invalid('请检查反馈文字、联系方式或截图。');
        const attachments=b.attachments.map(attachment),d=b.diagnostics||{};
        if(Object.keys(d).some(k=>!['version','page','errorCode'].includes(k)))invalid('诊断信息包含不支持的字段。');
        const diagnostics={version:String(d.version||'').slice(0,80),page:String(d.page||'').slice(0,30),errorCode:String(d.errorCode||'').replace(/[^A-Z0-9_-]/gi,'').slice(0,60)};
        const fingerprint=hash(JSON.stringify({text:b.text.trim(),contact:b.contact,attachments,diagnostics}));
        return exclusive(state=>{
            const existing=state.items.find(r=>r.clientSubmissionId===b.clientSubmissionId);
            if(existing){if(clock()-Date.parse(existing.createdAt)>days*86400000)invalid('这条反馈已超过保存期限，请另建新反馈。',410,'FEEDBACK_EXPIRED');if(!secureEqual(existing.tokenHash,hash(b.queryToken)))invalid('未找到可查看的反馈。',404,'FEEDBACK_NOT_FOUND');if(existing.fingerprint!==fingerprint)invalid('这条反馈已经提交。修改后的内容请作为新反馈发送。',409,'FEEDBACK_ALREADY_SENT');return{value:publicRow(existing)};}
            // 保存期限到期后删除正文、附件与联系信息；在主动访问时清理，不依赖网页常开。
            state.items=state.items.filter(r=>clock()-Date.parse(r.createdAt)<days*86400000);
            if(state.items.length>=2000)invalid('反馈箱暂时已满，请稍后再试。',503);
            const now=new Date(clock()).toISOString(),row={id:crypto.randomUUID(),clientSubmissionId:b.clientSubmissionId,tokenHash:hash(b.queryToken),fingerprint,text:b.text.trim(),contact:b.contact,attachments,diagnostics,createdAt:now,updatedAt:now,status:'pending',reply:'',replyVersion:0};state.items.push(row);return{write:true,value:publicRow(row)};
        });
    });
    route('/lookup',async req=>{
        const b=req.body||{};if(!validToken(b.queryToken)||!b.clientSubmissionId)invalid('未找到可查看的反馈。',404,'FEEDBACK_NOT_FOUND');
        return exclusive(state=>{const row=state.items.find(r=>r.clientSubmissionId===b.clientSubmissionId&&secureEqual(r.tokenHash,hash(b.queryToken)));if(!row||clock()-Date.parse(row.createdAt)>days*86400000)invalid('反馈已不存在或已超过保存期限。',404,'FEEDBACK_NOT_FOUND');return{value:publicRow(row)};});
    });
    route('/delete',async req=>{
        const b=req.body||{};return exclusive(state=>{const index=state.items.findIndex(r=>r.clientSubmissionId===b.clientSubmissionId&&secureEqual(r.tokenHash,hash(String(b.queryToken||''))));if(index<0)invalid('未找到可删除的反馈。',404,'FEEDBACK_NOT_FOUND');state.items.splice(index,1);return{write:true,value:{deleted:true}};});
    });
    route('/admin/list',async req=>{admin(req);return exclusive(state=>{const before=state.items.length;state.items=state.items.filter(r=>clock()-Date.parse(r.createdAt)<days*86400000);return{write:before!==state.items.length,value:{items:[...state.items].reverse().map(({tokenHash,fingerprint,clientSubmissionId,...r})=>r),retentionDays:days}};});});
    route('/admin/reply',async req=>{admin(req);const {id,reply,status}=req.body||{};if(typeof reply!=='string'||reply.length>5000||!['pending','working','replied','resolved'].includes(status))invalid('请检查回复内容与状态。');return exclusive(state=>{const row=state.items.find(r=>r.id===id);if(!row)invalid('反馈未找到。',404);if(row.reply!==reply)row.replyVersion++;row.reply=reply;row.status=status;row.updatedAt=new Date(clock()).toISOString();return{write:true,value:publicRow(row)};});});
    route('/admin/delete',async req=>{admin(req);return exclusive(state=>{const before=state.items.length;state.items=state.items.filter(r=>r.id!==req.body?.id);if(before===state.items.length)invalid('反馈未找到。',404);return{write:true,value:{deleted:true}};});});
    return {router,config};
}
module.exports={createFeedback};
