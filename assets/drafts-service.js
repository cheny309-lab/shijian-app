/* 自动暂存只写本机，不发布、不发送AI。正式提交后原子移除输入草稿。 */
(function(){'use strict';window.ShijianDrafts={create(d){
    const {DB,node,button}=d;let tabId;try{tabId=sessionStorage.getItem('shijian.draftTab');if(!tabId){tabId=crypto.randomUUID();sessionStorage.setItem('shijian.draftTab',tabId);}}catch(_){tabId=crypto.randomUUID();}let composerId='composer:'+tabId,composerLoaded=false,resumeGeneration=0;let composerTimer,composerPending=Promise.resolve(),paused=false;const editors=new Map();
    const status=text=>{const e=document.getElementById('inputDraftStatus');if(e)e.textContent=text;};
    function saveComposer(){if(paused||!d.ready())return composerPending;const value=d.composerValue(),draftId=composerId;if(!composerLoaded&&!value.text&&!value.images.length)return composerPending;composerPending=composerPending.catch(()=>{}).then(async()=>{if(!value.text&&!value.images.length){await DB.remove('drafts',draftId);status('');return;}try{await DB.put('drafts',{id:draftId,kind:'composer',...value,updatedAt:new Date().toISOString()});status('已暂存于此设备');}catch(_){status('这次还没暂存好，请先复制文字留存。');}});return composerPending;}
    function scheduleComposer(){composerLoaded=true;resumeGeneration++;clearTimeout(composerTimer);composerTimer=setTimeout(()=>{void saveComposer();},800);}
    async function resumeComposer(targetId){const generation=++resumeGeneration;if(!d.ready())return;const current=d.composerValue();if((current.text||current.images.length)&&(!targetId||targetId===composerId))return;if(targetId&&targetId!==composerId&&(current.text||current.images.length))await saveComposer();await composerPending;const draft=await DB.get('drafts',targetId||composerId);if(draft&&generation===resumeGeneration){composerId=draft.id;composerLoaded=true;d.setComposer(draft);status('已接回上次没写完的内容');}}
    async function pause(){clearTimeout(composerTimer);paused=true;await composerPending;}
    function unpause(){paused=false;}
    function editorValue(session){return Object.fromEntries(Object.entries(session.fields).map(([k,e])=>[k,e.value]));}
    async function saveEditor(session){clearTimeout(session.timer);const payload=editorValue(session);if(JSON.stringify(payload)===session.base)return;try{await DB.put('drafts',{id:'editor:'+session.record.id,kind:'editor',recordId:session.record.id,baseRevision:session.record.editRevision||0,payload,updatedAt:new Date().toISOString()});if(session.status.isConnected)session.status.textContent='编辑草稿已暂存，正式日记尚未修改。';}catch(_){if(session.status.isConnected)session.status.textContent='这次没能暂存，请先复制文字留存。';}}
    async function attachEditor(root,record,fields){
        const info=node('p','muted'),session={root,record,fields,status:info,base:JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k,e])=>[k,e.value])))};editors.set(record.id,session);root.append(info);
        for(const e of Object.values(fields))e.addEventListener('input',()=>{clearTimeout(session.timer);session.timer=setTimeout(()=>{void saveEditor(session);},800);});
        const draft=await DB.get('drafts','editor:'+record.id);if(!root.isConnected||!draft)return;
        const box=node('div','review-note');box.append(node('p','','还有一份未保存的编辑。'+(draft.baseRevision!==(record.editRevision||0)?'原日记已有变化，载入后请对照再保存。':'')),button('继续编辑草稿',()=>{for(const [k,value]of Object.entries(draft.payload||{}))if(fields[k])fields[k].value=value;box.remove();info.textContent='已载入编辑草稿，保存后才会修改正式日记。';}),button('暂不载入',()=>box.remove()));root.append(box);
    }
    async function savedEditor(recordId){const session=editors.get(recordId);if(session){clearTimeout(session.timer);session.base=JSON.stringify(editorValue(session));session.status.textContent='';}await DB.remove('drafts','editor:'+recordId);}
    function flushEditors(){for(const session of editors.values()){void saveEditor(session);}editors.clear();}
    window.addEventListener('shijian-modal-close',flushEditors);
    window.addEventListener('pagehide',()=>{void saveComposer();flushEditors();});
    return{discardComposer:id=>{if(id===composerId){resumeGeneration++;clearTimeout(composerTimer);d.setComposer({text:'',images:[],intent:'auto',useAI:false});composerLoaded=false;status('');}},getComposerId:()=>composerId,scheduleComposer,saveComposer,resumeComposer,pause,unpause,attachEditor,savedEditor};
}};})();
