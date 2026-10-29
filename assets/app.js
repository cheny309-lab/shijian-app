/* 拾间应用层：输入、生活记录、账单视图分别组织；金额与去重交给 LedgerCore。 */
(function () {
    'use strict';
    const C = window.LedgerCore, DB = window.ShijianStorage, J = window.JournalCore, Quick = window.ShijianQuickBill, T = window.TrajectoryCore;
    const S = { records: [], sources: [], transactions: [], imports: [], reflections: [], meta: [], drafts: [], ready: false, saving: false, imageLoading: false,
        page: 'timeline', month: C.dayKey().slice(0, 7), currency: 'CNY', filter: 'all', category: '', book: 'all', batchMode: false, selected: new Set(), hideAmounts: false, autoAI: true };
    const $ = id => document.getElementById(id);
    const id = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const button = (text, fn, cls = 'quiet-button') => { const e = node('button', cls, text); e.type = 'button'; e.addEventListener('click', fn); return e; };
    const imageOK = s => typeof s === 'string' && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(s);
    const Life=window.ShijianLife;
    const Nav=window.ShijianNavigation.create({getPage:()=>S.page,setPage:page=>{S.previousPage=S.page;S.page=page;render();},blocked:()=>!S.ready||$('detailModal').classList.contains('show')||$('inputPanel').classList.contains('show')});
    const currentRecord = key => S.records.find(r => r.id === key);
    const Drafts = window.ShijianDrafts.create({DB,node,button,ready:()=>S.ready,composerValue:()=>({text:$('messageInput').value,images:S.drafts,intent:$('recordIntent').value,bookId:$('uploadBook').value,useAI:$('useAI').checked}),setComposer:draft=>{$('messageInput').value=draft.text||'';S.drafts=draft.images||[];$('recordIntent').value=draft.intent||'auto';S.intentTouched=!!draft.intent&&draft.intent!=='auto';$('uploadBook').value=books().some(b=>b.id===draft.bookId)?draft.bookId:'daily';$('useAI').checked=!!draft.useAI;renderDrafts();}});
    const Journals = window.ShijianJournals.create({ S, C, J, DB, node, button, field, input, modal, closeModal, refresh, report, toast, id, openRecord, showSource, runJournal, scheduleReflections, render, Drafts });
    const Trajectories=window.ShijianTrajectories.create({S,C,T,J,DB,node,button,modal,closeModal,refresh,report,toast,amount,Journals,books,bookName,openRecord,showSource,placeRecord,runBills,renderReflections,manageBooks,moveToBook,exportCSV,scheduleReflections});
    const Mine = window.ShijianMine.create({S,C,J,DB,node,button,modal,closeModal,toast,report,refresh,download,books,exportCSV,Journals,Trajectories,Drafts,openRecord,resumeComposer:async targetId=>{await openInputPanel(targetId);},getErrorCode:()=>S.lastErrorCode||'',preferencesChanged:()=>{$('useAI').checked=S.autoAI;scheduleReflections();}});
    let lastModalFocus;
    let toastTimer, reflectionTimer, reflectionRunning = false;
    const runningJournal = new Set(), runningBills = new Set();
    const tasks = []; let activeTasks = 0;
    function queue(work) {
        return new Promise((resolve, reject) => { tasks.push({ work, resolve, reject }); pump(); });
    }
    function pump() {
        while (activeTasks < 2 && tasks.length) {
            const task = tasks.shift(); activeTasks++;
            Promise.resolve().then(task.work).then(task.resolve, task.reject).finally(() => { activeTasks--; pump(); scheduleReflections(); });
        }
    }
    function toast(text) {
        $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
    }
    function notice(text) { $('storageNotice').textContent = text; $('storageNotice').hidden = !text; }
    function report(error) {
        const text = error && error.name === 'QuotaExceededError' ? '设备空间不足，输入仍保留。请先导出备份并释放空间。' : (error && error.message) || '这次操作尚未完成，请稍后重试。';
        S.lastErrorCode=error?.code||''; toast(text);
    }
    async function refresh() { Object.assign(S, await DB.snapshot(false)); S.hideAmounts=!!S.meta.find(m=>m.key==='hideAmounts')?.value;S.autoAI=S.meta.find(m=>m.key==='autoAI')?.value!==false;render(); }
    function books() {
        const value = (S.meta.find(m => m.key === 'books') || {}).value;
        return [{ id: 'daily', name: '日常' }, ...(Array.isArray(value) ? value.filter(b => b.id && b.id !== 'daily' && typeof b.name === 'string') : [])];
    }
    function bookName(bookId) { return (books().find(b => b.id === (bookId || 'daily')) || {}).name || '日常'; }
    function fillUploadBook() {
        const select = $('uploadBook'); select.replaceChildren();
        books().forEach(book => { const option = node('option', '', book.name); option.value = book.id; select.append(option); });
        select.value = S.book === 'all' ? 'daily' : S.book;
    }
    async function placeRecord(recordId, placement) {
        try {
            const record = await DB.updateRecord(recordId, old => ({ ...old, placement, placementUser: true, timelineHidden: placement === 'bills' }));
            await refresh(); toast(placement === 'journal' ? '已放入时光，文字可以继续修改。' : '仅在账单保留，交易和原图都没有删除。');
            if (placement === 'journal' && record && !record.journalDeleted && record.aiAllowed && !record.ai && !record.journalEdited) void runJournal(recordId);
            scheduleReflections();
        } catch (error) { report(error); }
    }
    async function routeSource(sourceId, kind) {
        const source = await DB.get('sources', sourceId); if (!source) return;
        for (const recordId of source.recordIds || []) {
            const routed = await DB.updateRecord(recordId, old => old.transactionIds ? old : C.routeRecord(old, kind));
            if (routed && routed.routingVersion && C.onTimeline(routed) && routed.aiAllowed && !routed.ai && !routed.journalEdited && !runningJournal.has(recordId)) void runJournal(recordId);
        }
    }
    function amount(minor, currency, force = false) {
        if (S.hideAmounts && !force) return '••••';
        if (!Number.isSafeInteger(minor) || !(currency in C.DIGITS)) return '金额未读清';
        const digits = C.DIGITS[currency];
        return (currency === 'CNY' ? '¥ ' : currency + ' ') + (minor / 10 ** digits).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    async function post(url, body, ms = 125000) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
        try {
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const error = new Error(data && data.error && data.error.message || '服务暂不可用，原始资料仍保留。');
                error.code = data && data.error && data.error.code || 'HTTP_' + response.status;
                error.requestId = data && data.error && data.error.requestId || ''; throw error;
            }
            if (!data) throw Error('服务返回格式异常，原始资料仍保留。');
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw Error('等待整理超时，原始资料已保存，可以稍后重试。');
            if (error instanceof TypeError) throw Error('网络暂时没有连接上，原始资料已保存。');
            throw error;
        } finally { clearTimeout(timer); }
    }
    function message(text, preview) {
        const content = [];
        if (text) content.push({ type: 'text', text });
        if (preview) content.push({ type: 'image_url', image_url: { url: preview } });
        return { messages: [{ role: 'user', content }] };
    }

    // 输入模块：原文件留在设备，模型只接收压缩副本；同次可选择最多六张图。
    function readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(Error('图片读取失败，请重新选择。'));
            reader.onabort = () => reject(Error('图片读取已取消。')); reader.readAsDataURL(file);
        });
    }
    async function hash(value) {
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    }
    async function prepare(file) {
        if (file.size > 20 * 1024 * 1024) throw Error('单张图片请控制在20MB以内。');
        const original = await readFile(file);
        const preview = await new Promise((resolve, reject) => {
            const image = new Image(); image.onerror = () => reject(Error('暂不能读取这张图片，请使用JPG、PNG或WebP。'));
            image.onload = () => {
                try {
                    // 竖长账单保留较高分辨率；极长截图请拆分，避免压成无法阅读的小字。
                    if (image.naturalHeight / image.naturalWidth > 10) throw Error('这张账单较长，请分成几张稍有重叠的截图再上传；本次输入仍保留。');
                    const scale = Math.min(1, 1600 / image.naturalWidth, 4096 / image.naturalHeight);
                    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                    const ctx = canvas.getContext('2d'); if (!ctx) throw Error('当前浏览器不能处理图片。');
                    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                    const data = canvas.toDataURL('image/jpeg', .86);
                    if (data.length > 3 * 1024 * 1024) throw Error('图片压缩后仍较大，请分段截图。');
                    resolve(data);
                } catch (error) { reject(error); }
            }; image.src = original;
        });
        return { id: 'file-' + await hash(await file.arrayBuffer()), name: file.name, original, preview, mime: file.type, bytes: file.size };
    }
    function updateSaveButton() {
        $('saveButton').disabled = !S.ready || S.saving || S.imageLoading || S.resuming;
        $('saveButton').textContent = S.saving ? '保存中…' : S.resuming ? '接回草稿中…' : S.imageLoading ? '图片处理中…' : '保存';
    }
    function renderDrafts() {
        previewQuickBill();
        const root = $('draftImages'); root.replaceChildren();
        S.drafts.forEach((draft, index) => {
            const box = node('div', 'draft-thumb'); const img = node('img'); img.src = draft.preview; img.alt = '待保存图片 ' + (index + 1);
            box.append(img, button('移除', () => { S.drafts.splice(index, 1); renderDrafts(); Drafts.scheduleComposer(); })); root.append(box);
        });
    }
    async function onImages(event) {
        const files = Array.from(event.target.files || []); event.target.value = '';
        if (!files.length || S.imageLoading) return;
        if (files.length + S.drafts.length > 6) { toast('每次最多六张图片，可以分批留下。'); return; }
        S.imageLoading = true; updateSaveButton();
        try {
            // 全部处理成功后才替换草稿，失败不吞掉其他已选图片。
            const prepared = [];
            for (const file of files) prepared.push(await prepare(file));
            for (const draft of prepared) if (!S.drafts.some(d => d.id === draft.id)) S.drafts.push(draft);
            if(S.page==='timeline'&&!S.intentTouched&&$('recordIntent').value==='auto')$('recordIntent').value=/^(?:请)?(?:只记账|仅记账|只留轨迹|仅留轨迹)/.test($('messageInput').value.trim())?'bill':'journal';
            renderDrafts(); Drafts.scheduleComposer();
        } catch (error) { report(error); }
        finally { S.imageLoading = false; updateSaveButton(); }
    }
    async function openInputPanel(targetId) {
        if(S.resuming)return;
        fillUploadBook();
        if(!$('messageInput').value.trim()&&!S.drafts.length){S.intentTouched=false;$('recordIntent').value=S.page==='bills'?'bill':'auto';}
        $('inputPanel').classList.add('show'); $('inputOverlay').classList.add('show');
        $('inputPanel').setAttribute('aria-hidden', 'false'); document.body.classList.add('panel-open');
        S.resuming=true;const controls=[$('messageInput'),$('imageInput'),$('recordIntent'),$('uploadBook'),$('useAI')];controls.forEach(e=>e.disabled=true);updateSaveButton();
        try{await Drafts.resumeComposer(typeof targetId==='string'?targetId:undefined);}catch(error){report(error);}finally{S.resuming=false;controls.forEach(e=>e.disabled=false);updateSaveButton();previewQuickBill();}
    }
    function closeInputPanel() {
        if (S.saving) return;
        $('inputPanel').classList.remove('show'); $('inputOverlay').classList.remove('show');
        $('inputPanel').setAttribute('aria-hidden', 'true'); document.body.classList.remove('panel-open'); $('messageInput').blur(); void Drafts.saveComposer();
    }
    function quickProposal(){return !S.drafts.length&&$('recordIntent').value!=='journal'?Quick.parse($('messageInput').value,new Date(),S.meta.find(m=>m.key==='defaultCurrency')?.value||'CNY'):null;}
    function previewQuickBill(){
        const p=quickProposal(),root=$('quickBillPreview');root.replaceChildren();root.hidden=!p;
        if(!p)return;
        root.append(node('p','',`将记下：${p.occurredAt} · ${p.merchant} · ${amount(p.amountMinor,p.currency)}${p.paymentMethod?' · '+p.paymentMethod:''}`),node('p','muted',`只入账本 · ${p.category}（可修改） · 原话留在本机${p.dateDefaulted?' · 未写日期按今天记录':''}。本次入账在本机完成；${$('useAI').checked?'已允许AI日月回看使用这笔信息':'未允许这笔信息参与AI回看'}。`));
    }
    async function saveRecord() {
        if (!S.ready || S.saving || S.imageLoading || S.resuming) return;
        const text = $('messageInput').value.trim();
        if (!text && !S.drafts.length) { toast('一句话，或一张图片，都可以。'); return; }
        const quick=quickProposal();
        // 预览即默认结果，无逐笔确认任务。
        S.saving = true; updateSaveButton(); await Drafts.pause();
        const now = new Date().toISOString(), batchId = id(), useAI = !quick && $('useAI').checked, intent = quick ? 'bill' : $('recordIntent').value === 'auto' && /^(?:请)?(?:只记账|仅记账|仅入账)/.test(text) ? 'bill' : $('recordIntent').value, bookId = $('uploadBook').value || 'daily';
        const records = [], sources = [];
        try {
            const drafts = S.drafts.length ? S.drafts : [null];
            for (let i = 0; i < drafts.length; i++) {
                const draft = drafts[i], recordId = id(), sourceId = draft ? draft.id : 'text-' + recordId;
                const record = { id: recordId, batchId, time: now, text: i === 0 ? text : '', image: draft ? draft.preview : null,
                    sourceIds: [sourceId], ai: '', aiStatus: 'idle', error: '', aiAllowed: useAI, routingVersion: 1, intent, bookId,
                    hasNarrative: !quick && i === 0 && !!text && !/^(?:请|帮我|这张|这是|上传|识别|一份|一张|份|的|流水|消费|明细|本月|本周|账单|截图|记账|只记账|仅记账|微信|支付宝|银行|支付|单笔|月度|汇总|支出|记录|[0-9一二三四五六七八九十零年月日，。！、：:\s/-])+$/u.test(text),
                    placement: intent === 'bill' ? 'bills' : intent === 'journal' ? 'journal' : !draft&&!/[¥￥$元]|支出|收入|花了|付款|退款/.test(text)?'journal':'pending' };
                records.push(record);
                sources.push({ ...(draft || {}), id: sourceId, recordIds: [recordId], text: record.text, uploadedAt: now, batchId, bookId, kind: draft ? 'image' : 'text',aiAllowed:$('useAI').checked });
            }
            if(quick){records[0].receipt=true;records[0].entryMethod='text';records[0].aiAllowed=$('useAI').checked;sources[0].entryMethod='text';}
            const savedQuick=await DB.saveBatch(records, sources, Drafts.getComposerId(),quick?{...Quick.transaction(quick,sources[0].id,bookId),aiAllowed:$('useAI').checked}:undefined);
            $('messageInput').value = ''; S.drafts = []; renderDrafts();
            S.saving = false; closeInputPanel(); previewQuickBill(); await refresh(); toast(quick ? '已记下 · '+quick.merchant+' '+amount(quick.amountMinor,quick.currency)+(quick.paymentMethod?' · '+quick.paymentMethod:'')+'，想改时随手点一下。' : useAI ? '已保存在此设备，正在轻轻整理。' : '已保存在此设备，未发送给AI。');
            if (useAI) {
                // 消费只自动进入轨迹，不主动弹日记选择。
                records.filter(C.onTimeline).forEach(record => { void runJournal(record.id); });
                for (const source of sources) if (intent!=='journal' && (intent === 'bill' || source.preview || /[¥￥$元]|支出|收入|花了|付款|退款/.test(source.text))) void runBills(source.id);
            }
        } catch (error) { notice('本次保存未完成，输入仍保留。请检查设备存储并导出已有记录。'); report(error); }
        finally { S.saving = false; Drafts.unpause(); updateSaveButton(); }
    }

    // 日记模块：只按最新记录合并 AI 结果，用户编辑后的正文绝不被迟到回复覆盖。
    async function runJournal(recordId, manual = false) {
        if (runningJournal.has(recordId)) return;
        runningJournal.add(recordId);
        try {
            await queue(async () => {
                const record = await DB.get('records', recordId); if (!record || record.journalDeleted || !(C.onTimeline(record) || manual && record.journalState === 'draft')) return;
                const requestEpoch=(await DB.get('meta','importEpoch'))?.value||'';
                await DB.updateRecord(recordId, old => ({ ...old, aiStatus: 'generating', error: '' })); await refresh();
                try {
                    let journalText = record.transactionIds ? J.prompt(record, await DB.getAll('transactions')) : record.text;
                    if (record.receipt && !record.transactionIds && !journalText) {
                        const rows = (await DB.getAll('transactions')).filter(t => !t.deleted && T.ready(t) && t.sourceIds.some(sid => (record.sourceIds || []).includes(sid)));
                        if (!rows.length) { await DB.updateRecord(recordId, old => ({ ...old, aiStatus: 'idle' })); return; }
                        journalText = '我主动选择把这些已确认记录留成一段生活日记。只按下面事实写，不推断感受或额外行程：' + rows.slice(0, 8).map(t => (T.period(t)||'日期未注明') + ' ' + C.merchantLabel(t) + ' ' + t.category).join('；');
                    }
                    const data = await post('/api/journal', message(journalText, record.receipt ? null : record.image), 65000);
                    const text = data.text;
                    if (typeof text !== 'string' || !text.trim()) throw Error('这次没有整理出文字，原始记录仍在。');
                    await DB.updateRecord(recordId, (old,epochChanged) => ({ ...old, ...(!epochChanged&&!J.hasOwnTitle(old)?{autoTitle:data.title||J.suggestTitle(text)}:{}), ...(old.journalEdited||epochChanged ? { aiCandidate: text.trim() } : { ai: text.trim() }), aiStatus: 'done', error: '', errorCode: '', requestId: '' }),requestEpoch);
                } catch (error) {
                    await DB.updateRecord(recordId, (old,epochChanged) => epochChanged?old:({ ...old, aiStatus: 'failed', error: error.message, errorCode: error.code || '', requestId: error.requestId || '' }),requestEpoch);
                }
            });
        } catch (error) { notice('原始记录已保留，但整理状态未能写入设备，请先导出备份。'); }
        finally { runningJournal.delete(recordId); await refresh().catch(report); window.dispatchEvent(new CustomEvent('shijian-journal-updated', { detail: recordId })); }
    }
    function renderTimeline() {
        const root = $('timelineContainer'); root.replaceChildren();
        const grouped = new Map();
        const drafts = S.records.filter(r => !r.journalDeleted && r.journalState === 'draft');
        if (drafts.length) root.append(button(`${drafts.length} 篇日记草稿，想看时再打开`, Journals.drafts, 'material-link'));
        [...S.records].filter(C.onTimeline).sort((a, b) => J.day(b).localeCompare(J.day(a)) || b.time.localeCompare(a.time) || b.id.localeCompare(a.id)).forEach(r => { const d = J.day(r); if (!grouped.has(d)) grouped.set(d, []); grouped.get(d).push(r); });
        if (!grouped.size) { root.append(node('p', 'empty-state', '这里，留给你想记住的日常。')); return; }
        for (const [day, records] of grouped) {
            const group = node('section', 'day-group'), date = node('div', 'date-side'), track = node('div', 'timeline-track'), content = node('div', 'content-side');
            date.append(node('div', 'date-num', day.slice(8)), node('div', 'date-month', +day.slice(5, 7) + '月')); track.append(node('div', 'dot'));
            for (const record of records) {
                const card = node('article', 'record-item'); card.dataset.recordId = record.id; card.tabIndex = 0; card.setAttribute('role', 'button');
                card.append(node('h3', 'content-title', J.title(record)));
                if (!record.receipt && imageOK(record.image)) { const img = node('img', 'content-image'); img.src = record.image; img.alt = '记录图片'; img.loading = 'lazy'; card.append(img); }
                card.append(node('p', 'content-text', J.body(record) || (record.receipt ? '这一刻，可以添一句自己的话。' : record.image ? '图片已留下，点开看看。' : '这一刻，也可以留白。')));
                if (['queued', 'generating'].includes(record.aiStatus)) card.append(node('p', 'record-status', '原始记录已保存 · 正在整理文字…'));
                if (record.aiStatus === 'failed') {
                    card.append(node('p', 'record-status', record.error || '原始记录已保留，文字暂未整理。'));
                    card.append(button('重试AI整理', event => { event.stopPropagation(); void runJournal(record.id); }, 'retry-btn'));
                }
                const billJobs = S.imports.filter(job => (record.sourceIds || []).includes(job.id));
                if (billJobs.some(job => job.status === 'failed')) {
                    card.append(node('p', 'record-status', '图片与日记已保留 · 账单识别尚未完成'));
                    card.append(button('查看账单识别问题', event => { event.stopPropagation(); S.page = 'bills'; render(); }, 'retry-btn'));
                } else if (billJobs.some(job => job.status === 'running')) card.append(node('p', 'record-status', '正在单独识别账单…'));
                card.addEventListener('click', () => openRecord(record.id)); card.addEventListener('keydown', e => { if (e.key === 'Enter') openRecord(record.id); }); content.append(card);
            }
            group.append(date, track, content); root.append(group);
        }
    }
    function modal(title) {
        if(!$('detailModal').classList.contains('show'))lastModalFocus=document.activeElement;
        document.querySelectorAll('.header,.bottom-container,#timelineContainer,#billsPage,#minePage').forEach(e=>{e.inert=true;e.setAttribute('aria-hidden','true');});
        $('detailModal').setAttribute('role','dialog');$('detailModal').setAttribute('aria-modal','true');$('detailModal').setAttribute('aria-label',title);
        window.dispatchEvent(new Event('shijian-modal-close'));
        $('detailModal').classList.remove('choice-sheet');
        const root = $('modalContent'); root.replaceChildren(); const card = node('div', 'detail-card'); card.append(node('h2', 'detail-title', title)); root.append(card);
        $('detailModal').classList.add('show'); $('detailModal').scrollTop = 0; return card;
    }
    function closeModal() { window.dispatchEvent(new Event('shijian-modal-close')); $('detailModal').classList.remove('show', 'choice-sheet');document.querySelectorAll('.header,.bottom-container,#timelineContainer,#billsPage,#minePage').forEach(e=>{e.inert=false;e.removeAttribute('aria-hidden');});if(lastModalFocus?.isConnected)lastModalFocus.focus(); }
    async function showSource(sourceId,explicit=false) {
        if(S.hideAmounts&&!explicit){const box=modal('查看原始资料');box.append(node('p','muted','原始图片和文字可能包含真实金额，不会自动遮挡。'),button('确认查看原始资料',()=>{void showSource(sourceId,true);},'primary-button'));return;}
        let source;
        try { source = await DB.get('sources', sourceId); } catch (error) { report(error); return; }
        if (!source) { toast('未找到这份来源。'); return; }
        const root = modal('原始资料'); root.append(node('p', 'muted', '仅保存在此设备 · ' + new Date(source.uploadedAt).toLocaleString()));
        if (source.legacyCompressed) root.append(node('p', 'muted', '这是旧版留下的图片副本，原文件未留存。'));
        const picture = imageOK(source.original) ? source.original : source.preview;
        if (imageOK(picture)) { const img = node('img', 'detail-image source-original'); img.src = picture; img.alt = source.name || '来源图片'; root.append(img); }
        if (source.text) root.append(node('p', 'detail-text', source.text));
        root.append(node('p', 'muted', source.name || '原始文字'));
        const related = S.transactions.filter(t => !t.deleted && t.sourceIds.includes(sourceId));
        related.forEach(t => root.append(button((t.merchant || '交易') + ' · ' + amount(t.amountMinor, t.currency), () => openTransaction(t.id))));
    }
    function openRecord(recordId) {
        const record = currentRecord(recordId); if (!record) return;
        const root = modal('时光切片'); root.append(node('p', 'detail-date', '记录创建于 ' + new Date(record.time).toLocaleString()));
        if (record.journalDeleted) { Journals.deleted(root, record); return; }
        const canRestorePlacement = record.timelineHidden || record.placement === 'pending';
        const eventDays = [...new Set(S.transactions.filter(t => !t.deleted && T.ready(t) && J.linked(record, t) && T.period(t).length===10).map(t => T.period(t)))].sort();
        if (eventDays.length && (eventDays.length > 1 || eventDays[0] !== C.dayKey(record.time))) root.append(node('p', 'muted', '关联记录日期为 ' + eventDays[0] + (eventDays.length > 1 ? ' 至 ' + eventDays.at(-1) : '') + '，账单按发生时间归入月份。'));
        if (!record.receipt && imageOK(record.image)) { const img = node('img', 'detail-image'); img.src = record.image; img.alt = '记录图片'; root.append(img); }
        const hasBillSource = record.receipt || ['bills', 'pending'].includes(record.placement) || (record.sourceIds || []).some(sid => S.imports.some(job => job.id === sid && (job.documentKind === 'bill' || job.extractedCount > 0)));
        if (hasBillSource && record.journalState !== 'draft' && !record.transactionIds) root.append(button(C.onTimeline(record) ? '仅保留到账单，不在时光展示' : '也想留下这一刻', async () => { if (C.onTimeline(record)) { await placeRecord(recordId, 'bills'); openRecord(recordId); } else if (canRestorePlacement) { await placeRecord(recordId, 'journal'); openRecord(recordId); } else await Journals.choose(record.sourceIds || []); }));
        Journals.editor(root, record);
        if (hasBillSource) root.append(button('从账单选择日记方式', () => { void Journals.choose(record.sourceIds || []); }));
        for (const sid of record.sourceIds || []) root.append(button('查看来源原图／文字', () => showSource(sid)));
        const bills = S.transactions.filter(t => !t.deleted && J.linked(record, t));
        bills.forEach(t => root.append(button('关联账单 · ' + (t.merchant || '交易') + ' ' + amount(t.amountMinor, t.currency), () => openTransaction(t.id))));
        const alreadyExtracted = (record.sourceIds || []).some(sid => S.imports.some(job => job.id === sid && job.status === 'done'));
        root.append(button(alreadyExtracted ? '重新识别账单（保留已有修改）' : '从这条记录识别账单', async () => {
            try {
                let sources = record.sourceIds || [];
                if (!sources.length) {
                    const sourceId = 'legacy-' + record.id;
                    await DB.saveBatch([{ ...currentRecord(recordId), sourceIds: [sourceId] }], [{ id: sourceId, kind: record.image ? 'image' : 'text', preview: record.image || '', original: record.image || '', text: record.text || '', uploadedAt: record.time, recordIds: [recordId], legacyCompressed: true }]);
                    sources = [sourceId]; await refresh();
                }
                for (const sid of sources) void runBills(sid, true);
                toast('已安排识别，原来的文字不会改变。');
            } catch (error) { report(error); }
        }));
    }

    // 账单流水线：候选、校验、去重与入账为独立阶段，失败留在来源任务中。
    async function runBills(sourceId, retry = false) {
        if (runningBills.has(sourceId)) return;
        runningBills.add(sourceId);
        try {
            await queue(async () => {
                const source = await DB.get('sources', sourceId); if (!source) return;
                const old = await DB.get('imports', sourceId);
                if (old && old.status === 'done' && !retry) { await routeSource(sourceId, old.documentKind || (old.extractedCount || (old.totals || []).length ? 'bill' : 'uncertain')); toast('这份来源已整理，不会重复计入。'); return; }
                const token = id();
                const claim = await DB.changeLedger(state => {
                    const latest = state.imports.find(i => i.id === sourceId);
                    if (latest && (latest.status === 'done' && !retry || latest.status === 'running' && Date.now() - Date.parse(latest.startedAt || 0) < 130000)) return { claimed: false };
                    return { claimed: true, reprocess: !!latest && latest.extractedCount !== undefined, imports: [{ ...(latest || {}), id: sourceId, token, status: 'running', startedAt: new Date().toISOString(), error: '' }] };
                });
                if (!claim.claimed) { const latest = await DB.get('imports', sourceId); if (latest && latest.status === 'done') await routeSource(sourceId, latest.documentKind || (latest.extractedCount ? 'bill' : 'uncertain')); toast('这份来源已经在整理或已完成，不会重复提交。'); return; }
                await refresh();
                try {
                    const data = await post('/api/bills/extract', message(source.text, source.preview));
                    if (!Array.isArray(data.transactions) || !Array.isArray(data.totals)) throw Error('账单返回格式不完整，尚未入账。');
                    const candidates = data.transactions.map((raw, index) => {
                        const candidate = T.normalize(raw, sourceId, index,{documentKind:C.documentKind(data),aiAllowed:source.aiAllowed,feeling:source.text});
                        candidate.bookId = source.bookId || 'daily';
                        // 显式重新识别保留已有交易；新候选重新走去重与核对，不能覆盖用户的修改。
                        if (claim.reprocess) candidate.id = sourceId + ':attempt:' + token + ':row:' + index;
                        return candidate;
                    });
                    const warnings = [...(Array.isArray(data.warnings) ? data.warnings : []), ...C.checkTotals(candidates, data.totals)];
                    if (C.documentKind(data) === 'bill' && !candidates.length && !data.totals.length) warnings.push('已识别为账单资料，但没有提取出明细；原图仍在，可以重新识别或补充清晰截图。');
                    if (data.truncated) {
                        warnings.push('这份资料超过单张处理范围，候选暂不入账，请分段上传并核对。');
                        candidates.forEach(t => { t.status = 'review'; t.confirmation = ''; t.reasons.push('来源未完整识别'); });
                    }
                    await DB.changeLedger(state => {
                        const latest = state.imports.find(i => i.id === sourceId);
                        if (!latest || latest.token !== token || latest.status === 'done') return {};
                        // 只从用户明确修正的商户归类中学习；不扩散推测的生活标签。
                        for (let i=0;i<candidates.length;i++) {
                            const t=candidates[i];
                            const pref = state.meta.find(m => m.key === 'category:' + t.merchant.trim().toLowerCase());
                            if (pref && C.CATEGORIES.includes(pref.value)) { t.category = pref.value; t.categoryTentative = false; }
                            candidates[i]=Life.apply(t,state.meta);
                        }
                        const merged = T.ingest(state.transactions, candidates);
                        const attempts = [...(latest.attempts || []), { at: new Date().toISOString(), token, extractedCount: candidates.length, linked: merged.linked }];
                        return { transactions: merged.transactions, imports: [{ id: sourceId, status: 'done', documentKind: C.documentKind(data), finishedAt: new Date().toISOString(), totals: data.totals, warnings, extractedCount: candidates.length, linked: merged.linked, attempts }] };
                    });
                    await routeSource(sourceId, C.documentKind(data));
                    if(candidates.length)toast('已留在轨迹，随时回看。');else if(data.totals.length)toast('这份记录已留下。');
                } catch (error) {
                    await DB.changeLedger(state => {
                        const latest = state.imports.find(i => i.id === sourceId);
                        return !latest || latest.token !== token ? {} : { imports: [{ ...latest, status: 'failed', error: error.message, errorCode: error.code || '', requestId: error.requestId || '', failedAt: new Date().toISOString() }] };
                    });
                }
            });
        } catch (error) { report(error); }
        finally { runningBills.delete(sourceId); await refresh().catch(report); scheduleReflections(); }
    }
    function renderBills() { Trajectories.render(); }
    async function moveToBook(ids, bookId) {
        await DB.changeLedger(state => ({ transactions: state.transactions.filter(t => ids.includes(t.id) || t.refundOf && ids.includes(t.refundOf) && !t.bookManuallySet)
            .map(t => C.edit(t, { bookId, bookManuallySet: ids.includes(t.id) }, '调整用途账本')) }));
    }
    function manageBooks() {
        const root = modal('用途账本'); root.append(node('p', 'muted', '按用途整理，不代表银行卡账户。每笔交易只有一个归属，全部账本不会重复相加。'));
        books().forEach(b => root.append(button(b.name, () => { S.book = b.id; S.selected.clear(); closeModal(); renderBills(); })));
        const name = input('', '新账本名称', root); name.maxLength = 16; name.placeholder = '如：工作报销、生活娱乐';
        const error = node('p', 'form-error'); root.append(error);
        root.append(button('创建账本', async () => {
            try {
                const value = name.value.trim(); if (!value) throw Error('给账本起一个名字。');
                const book = { id: 'book-' + id(), name: value.slice(0, 16) };
                await DB.changeLedger(state => { const old = (state.meta.find(m => m.key === 'books') || {}).value || [];
                    if ([{ name: '日常' }, ...old].some(b => b.name.normalize('NFKC').toLowerCase() === book.name.normalize('NFKC').toLowerCase())) throw Error('已经有同名账本。');
                    return { meta: [{ key: 'books', value: [...old, book] }] }; });
                S.book = book.id; await refresh(); closeModal(); toast('账本已创建，原来的交易没有移动。');
            } catch (e) { error.textContent = e.message; }
        }, 'primary-button'));
    }
    function field(root, label, element) {
        const wrap = node('div', 'form-field'), name = node('label', '', label);
        element.id = 'field-' + id(); name.htmlFor = element.id;
        wrap.append(name, element); root.append(wrap); return element;
    }
    function input(value, label, root) { const e = node('input'); e.value = value || ''; return field(root, label, e); }
    function openTransaction(id) { Trajectories.open(id); }

    // 回看模块：仅下一次唤醒时补做已结束期间，不通知，不填补空白日期。
    function scheduleReflections() {
        clearTimeout(reflectionTimer);
        if (!S.ready || !S.autoAI || S.meta.some(m=>m.key==='importPauseAI'&&m.value) || activeTasks || tasks.length || reflectionRunning) return;
        reflectionTimer = setTimeout(() => { void runReflections(); }, 1800);
    }
    async function runReflections(manualIds) {
        if (reflectionRunning || !S.ready || (!S.autoAI && !manualIds) || (!manualIds&&S.meta.some(m=>m.key==='importPauseAI'&&m.value))) return;
        reflectionRunning = true;
        let jobs = [],requestEpoch='';
        try {
            await refresh();requestEpoch=(await DB.get('meta','importEpoch'))?.value||'';
            const existing = manualIds ? S.reflections.filter(r => !manualIds.includes(r.id)) : S.reflections;
            jobs = T.reflectionJobs(S.transactions, S.records.filter(r => r.aiAllowed === true && C.onTimeline(r)), existing, C.dayKey(), manualIds ? Number.MAX_SAFE_INTEGER : 6);
            if (manualIds) jobs = jobs.filter(j => manualIds.includes(j.id)).slice(0, 6);
            while (jobs.length > 1 && JSON.stringify(jobs).length > 20000) jobs.pop();
            if (!jobs.length) return;
            for (const job of jobs) {
                const old = await DB.get('reflections', job.id);
                await DB.put('reflections', { ...(old || {}), id: job.id, attemptedRevision: job.revision, status: 'running' });
            }
            const data = await post('/api/reflections', { periods: jobs });
            for (const job of jobs) {
                const item = data.items && data.items.find(i => i.id === job.id && typeof i.text === 'string');
                if (!item) throw Error('生活回看返回不完整。');
                await DB.updateReflection(job.id,(old,epochChanged)=>epochChanged?(old?{...old,candidate:item.text}:undefined):({ ...old, id: job.id, ...(old && old.edited ? { candidate: item.text } : { text: item.text }), revision: job.revision, status: 'done', error: '', updatedAt: new Date().toISOString() }),requestEpoch);
            }
        } catch (error) {
            for (const job of jobs) {
                await DB.updateReflection(job.id,(old,epochChanged)=>old&&!epochChanged?({...old,status:'failed',error:error.message}):old,requestEpoch).catch(()=>{});
            }
        } finally { reflectionRunning = false; await refresh().catch(report); }
    }
    function renderReflections(root) {
        const entries = S.reflections.filter(r => r.id.startsWith(S.month)).sort((a, b) => a.id.length - b.id.length || b.id.localeCompare(a.id));
        if (!entries.length) return;
        const section = node('section', 'bill-section'); section.append(node('h3', '', '这一月的片段'));
        entries.forEach(r => {
            const box = node('details', 'reflection'); box.append(node('summary', '', r.id.length === 7 ? '这一月，慢慢回看' : r.id.slice(5).replace('-', '月') + '日'));
            const hasData = S.transactions.some(t => !t.deleted && T.ready(t) && T.period(t).startsWith(r.id)) || S.records.some(note => note.aiAllowed === true && C.onTimeline(note) && J.day(note).startsWith(r.id));
            if (!hasData) box.append(node('p', 'muted', '对应的数据已移除或修正，这里保留原来的回看文字。'));
            if (r.text) box.append(node('p', 'detail-text', r.text));
            if (r.status === 'running') box.append(node('p', 'muted', '正在整理已有记录…'));
            if (r.status === 'failed') { box.append(node('p', 'muted', r.error || '回看未完成，账本不受影响。')); box.append(button('重试这一段回看', () => { void runReflections([r.id]); })); }
            box.append(button('用自己的话修改', () => {
                const card = modal('属于你的回看'); const text = node('textarea', 'journal-editor'); text.value = r.text || ''; text.maxLength = 8000; text.setAttribute('aria-label', '编辑生活回看'); card.append(text);
                card.append(button('保存', async () => { try { const latest = await DB.get('reflections', r.id); await DB.put('reflections', { ...latest, text: text.value, edited: true, editHistory: [...(latest.editHistory || []), { at: new Date().toISOString(), before: latest.text || '', after: text.value }] }); await refresh(); closeModal(); } catch (error) { report(error); } }, 'primary-button'));
                if (r.candidate) { card.append(node('p', 'detail-label', 'AI的新候选 · 可复制或采用'), node('p', 'detail-text', r.candidate)); card.append(button('采用候选', () => { text.value = r.candidate; })); }
            })); section.append(box);
        }); root.append(section);
    }

    // 私密与备份的最小入口；完整“我的”与导入恢复留给下一模块。
    function download(blob, name) {
        const url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
    async function exportData() { await Mine.exportBackup(); }
    async function exportCSV(options = {}) {
        try {
            const data=C.inBook(await DB.getAll('transactions'),options.book||'all');
            const rows=[...T.groups(data),...(options.includeDeleted?T.groups(data,{includeDeleted:true}):[])].filter(g=>!options.month||g.period.startsWith(options.month)).map(g=>({...g.row,sourceIds:g.sourceIds,exportPeriod:g.period,exportApproximate:g.approximate,exportConflict:g.conflict}));
            const cell = value => '"' + String(value == null ? '' : value).replace(/^(?:\s*[=+\-@]|[\t\r])/, s => "'" + s).replace(/"/g, '""') + '"';
            const table = [['编号', '发生时间', '来源商户', '展示简称', '细分用途', '账本', '方向', '金额', '币种', '类别', '标签', '记录状态', '已移除', '来源编号', '支付方式', '录入方式', '整理说明', '自己的感受','生活大类','生活小类','场景或地点'], ...rows.map(t => [t.id, t.exportPeriod, t.merchant, C.merchantLabel(t), t.subcategory || '', bookName(t.bookId), t.direction, t.exportConflict?'金额未定':t.amountMinor === null || !(t.currency in C.DIGITS) ? '未读清' : C.decimal(t.amountMinor, t.currency), t.currency, t.category, t.tags.join('、'), t.deleted?'已移除':'已留下', t.deleted ? '是' : '否', t.sourceIds.join(';'),t.paymentMethod||'',t.entryMethod==='text'?'手动短句':'资料识别',t.exportConflict?'冲突来源，未计入明确金额':t.exportApproximate?'相似来源按一次整理，近似项':'独立记录',t.feeling||'',Life.parts(t).major,Life.parts(t).minor,Life.parts(t).scene])];
            download(new Blob(['\ufeff' + table.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'shijian-bills-' + C.dayKey() + '.csv');
        } catch (error) { report(error); }
    }
    function renderMine() { Mine.render(); }
    function render() {
        Nav.capture();
        renderTimeline(); renderBills(); renderMine();
        $('timelineContainer').hidden = S.page !== 'timeline'; $('billsPage').hidden = S.page !== 'bills'; $('minePage').hidden = S.page !== 'mine';
        document.querySelectorAll('[data-page]').forEach(e => { e.classList.toggle('active', e.dataset.page === S.page); e.setAttribute('aria-current', e.dataset.page === S.page ? 'page' : 'false'); });
        Nav.restore(S.page);
    }
    async function recoverImports() {
        if (!S.ready) return;
        const jobs = await DB.getAll('imports');
        if (!jobs.some(job => job.status === 'running' && Date.now() - Date.parse(job.startedAt || 0) > 130000)) return;
        await DB.changeLedger(state => ({ imports: state.imports.filter(job => job.status === 'running' && Date.now() - Date.parse(job.startedAt || 0) > 130000)
            .map(job => ({ ...job, status: 'failed', error: '上次识别已中断，原始资料仍在，可以重试。' })) }));
        await refresh();
    }
    async function init() {
        Nav.mount();
        $('currentMonth').textContent = new Date().getFullYear() + '年' + (new Date().getMonth() + 1) + '月';
        $('messageInput').addEventListener('input',Drafts.scheduleComposer);
        $('messageInput').addEventListener('input',previewQuickBill);
        $('recordIntent').addEventListener('change',()=>{S.intentTouched=true;previewQuickBill();});
        $('useAI').addEventListener('change',previewQuickBill);
        for(const key of ['recordIntent','uploadBook','useAI'])$(key).addEventListener('change',Drafts.scheduleComposer);
        const draftStatus=node('p','muted');draftStatus.id='inputDraftStatus';$('draftImages').after(draftStatus);
        $('imageInput').addEventListener('change', onImages); $('exportButton').addEventListener('click', exportData);
        document.querySelectorAll('[data-page]').forEach(e => e.addEventListener('click', () => { Nav.go(e.dataset.page); }));
        window.addEventListener('shijian-storage-closed', () => { S.ready = false; updateSaveButton(); notice('另一页面正在升级数据，请关闭其他拾间页面后刷新。'); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeInputPanel(); } });
        const viewport = window.visualViewport;
        if (viewport) { const resize = () => document.documentElement.style.setProperty('--keyboard-inset', Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) + 'px'); viewport.addEventListener('resize', resize); viewport.addEventListener('scroll', resize); }
        try {
            const loaded = await DB.init(); Object.assign(S, loaded.data); notice(loaded.warning);
            S.hideAmounts = !!(S.meta.find(m => m.key === 'hideAmounts') || {}).value;
            S.autoAI = (S.meta.find(m => m.key === 'autoAI') || {}).value !== false; $('useAI').checked = S.autoAI;
            for (const record of S.records) if (['queued', 'generating'].includes(record.aiStatus)) await DB.updateRecord(record.id, old => ({ ...old, aiStatus: 'failed', error: '上次整理未完成，原始记录仍在，可以重试。' }));
            // 打开的另一页可能仍在工作；只有超时任务才标为中断，不自动再次调用收费接口。
            for (const job of S.imports) if (job.status === 'running' && Date.now() - Date.parse(job.startedAt || 0) > 130000) await DB.put('imports', { ...job, status: 'failed', error: '上次识别未完成，原始资料仍在，可以重试。' });
            for (const r of S.reflections) if (r.status === 'running') await DB.put('reflections', { ...r, status: 'failed', error: '上次梳理未完成，账本不受影响。' });
            S.ready = true; await refresh(); const task=S.meta.find(m=>m.key==='importTask')?.value;if(task?.state==='reading')notice('上次恢复未完成，请重新选择备份文件。原有记录未作更改。');scheduleReflections();
        } catch (error) { S.lastErrorCode='STORAGE_INIT';notice('此浏览器的保存功能暂时未就绪。请关闭其他拾间页面后刷新，保留已有数据，不要清除网站存储。'); }
        render(); updateSaveButton();
        if(S.ready&&window.ShijianDesktop.standalone()&&!S.records.length&&!S.transactions.length)notice('这是桌面入口，记录保存在这里。若原来在微信或其他浏览器使用，请到“我的 → 导入恢复”带回备份，原入口先保留。');
        document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready) void recoverImports().then(refresh).then(scheduleReflections).catch(report); });
        setInterval(() => { if (S.ready) void recoverImports().catch(() => {}); }, 30000);
    }
    Object.assign(window, { openInputPanel, closeInputPanel, saveRecord, closeModal, exportData });
    window.ShijianApp = Object.freeze({ version: C.VERSION });
    void init();
})();
