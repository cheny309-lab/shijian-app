/* 拾间应用层：输入、生活记录、账单视图分别组织；金额与去重交给 LedgerCore。 */
(function () {
    'use strict';
    const C = window.LedgerCore, DB = window.ShijianStorage, J = window.JournalCore, Quick = window.ShijianQuickBill;
    const S = { records: [], sources: [], transactions: [], imports: [], reflections: [], meta: [], drafts: [], ready: false, saving: false, imageLoading: false,
        page: 'timeline', month: C.dayKey().slice(0, 7), currency: 'CNY', filter: 'all', category: '', book: 'all', batchMode: false, selected: new Set(), hideAmounts: false, autoAI: true };
    const $ = id => document.getElementById(id);
    const id = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const button = (text, fn, cls = 'quiet-button') => { const e = node('button', cls, text); e.type = 'button'; e.addEventListener('click', fn); return e; };
    const imageOK = s => typeof s === 'string' && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(s);
    const currentRecord = key => S.records.find(r => r.id === key);
    const Drafts = window.ShijianDrafts.create({DB,node,button,ready:()=>S.ready,composerValue:()=>({text:$('messageInput').value,images:S.drafts,intent:$('recordIntent').value,bookId:$('uploadBook').value,useAI:$('useAI').checked}),setComposer:draft=>{$('messageInput').value=draft.text||'';S.drafts=draft.images||[];$('recordIntent').value=draft.intent||'auto';$('uploadBook').value=books().some(b=>b.id===draft.bookId)?draft.bookId:'daily';$('useAI').checked=!!draft.useAI;renderDrafts();}});
    const Journals = window.ShijianJournals.create({ S, C, J, DB, node, button, field, input, modal, closeModal, refresh, report, toast, id, openRecord, showSource, runJournal, scheduleReflections, render, Drafts });
    const Mine = window.ShijianMine.create({S,C,J,DB,node,button,modal,closeModal,toast,report,refresh,download,books,exportCSV,Journals,Drafts,openRecord,resumeComposer:async targetId=>{await openInputPanel(targetId);},getErrorCode:()=>S.lastErrorCode||'',preferencesChanged:()=>{$('useAI').checked=S.autoAI;scheduleReflections();}});
    let quickKey='',quickConfirmed=false;
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
        if (!Number.isSafeInteger(minor) || !(currency in C.DIGITS)) return '金额待核对';
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
            renderDrafts(); Drafts.scheduleComposer();
        } catch (error) { report(error); }
        finally { S.imageLoading = false; updateSaveButton(); }
    }
    async function openInputPanel(targetId) {
        if(S.resuming)return;
        fillUploadBook();
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
    function quickProposal(){return !S.drafts.length&&$('recordIntent').value!=='journal'?Quick.parse($('messageInput').value):null;}
    function previewQuickBill(){
        const p=quickProposal(),root=$('quickBillPreview');root.replaceChildren();root.hidden=!p;
        const key=p?JSON.stringify(p):'';if(key!==quickKey){quickKey=key;quickConfirmed=false;}
        if(!p)return;
        root.append(node('p','',`将记下：${p.occurredAt} · ${p.merchant} · ${amount(p.amountMinor,p.currency)}${p.paymentMethod?' · '+p.paymentMethod:''}`),node('p','muted',`只入账本 · ${p.category}（可修改） · 原话留在本机${p.dateDefaulted?' · 未写日期按今天记录':''}。本次入账在本机完成；${$('useAI').checked?'已允许AI日月回看使用这笔信息':'未允许这笔信息参与AI回看'}。`));
        if(p.needsConfirmation){const check=node('input');check.type='checkbox';check.checked=quickConfirmed;check.id='quickBillConfirm';const label=node('label','check-label');label.append(check,node('span','','确认这是一笔人民币消费'));check.addEventListener('change',()=>{quickConfirmed=check.checked;});root.append(label);}
    }
    async function saveRecord() {
        if (!S.ready || S.saving || S.imageLoading || S.resuming) return;
        const text = $('messageInput').value.trim();
        if (!text && !S.drafts.length) { toast('一句话，或一张图片，都可以。'); return; }
        const quick=quickProposal();
        if(quick?.needsConfirmation&&!quickConfirmed){toast('请确认这是一笔人民币消费，再保存。');$('quickBillConfirm')?.focus();return;}
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
                    placement: intent === 'bill' ? 'bills' : intent === 'journal' || !draft ? 'journal' : 'pending' };
                records.push(record);
                sources.push({ ...(draft || {}), id: sourceId, recordIds: [recordId], text: record.text, uploadedAt: now, batchId, bookId, kind: draft ? 'image' : 'text' });
            }
            if(quick){records[0].receipt=true;records[0].entryMethod='text';records[0].aiAllowed=$('useAI').checked;sources[0].entryMethod='text';}
            const savedQuick=await DB.saveBatch(records, sources, Drafts.getComposerId(),quick?{...Quick.transaction(quick,sources[0].id,bookId),aiAllowed:$('useAI').checked}:undefined);
            $('messageInput').value = ''; S.drafts = []; renderDrafts();
            S.saving = false; closeInputPanel(); previewQuickBill(); await refresh(); toast(quick ? savedQuick?.status==='review'?'已留下，可能与已有账单重复，请在账单里核对。':'已记下 · '+quick.merchant+' '+amount(quick.amountMinor,quick.currency)+(quick.paymentMethod?' · '+quick.paymentMethod:'')+'，可在账单修改或移除。' : useAI ? '已保存在此设备，正在轻轻整理。' : '已保存在此设备，未发送给AI。');
            if (useAI) {
                if (intent === 'auto') for (const record of records) if (record.image && !record.hasNarrative) (record.sourceIds || []).forEach(Journals.markOffer);
                records.filter(C.onTimeline).forEach(record => { void runJournal(record.id); });
                for (const source of sources) if (intent === 'bill' || source.preview || /[¥￥$元]|支出|收入|花了|付款|退款/.test(source.text)) void runBills(source.id);
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
                        const rows = (await DB.getAll('transactions')).filter(t => !t.deleted && t.status === 'confirmed' && t.sourceIds.some(sid => (record.sourceIds || []).includes(sid)));
                        if (!rows.length) { await DB.updateRecord(recordId, old => ({ ...old, aiStatus: 'idle' })); return; }
                        journalText = '我主动选择把这些已确认记录留成一段生活日记。只按下面事实写，不推断感受或额外行程：' + rows.slice(0, 8).map(t => t.occurredAt + ' ' + C.merchantLabel(t) + ' ' + t.category).join('；');
                    }
                    const data = await post('/api/chat', message(journalText, record.receipt ? null : record.image), 65000);
                    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
                    if (typeof text !== 'string' || !text.trim()) throw Error('这次没有整理出文字，原始记录仍在。');
                    await DB.updateRecord(recordId, (old,epochChanged) => ({ ...old, ...(old.journalEdited||epochChanged ? { aiCandidate: text.trim() } : { ai: text.trim() }), aiStatus: 'done', error: '', errorCode: '', requestId: '' }),requestEpoch);
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
        const materials = S.records.filter(r => !r.journalDeleted && r.journalState !== 'draft' && (r.placement === 'pending' || r.placement === 'bills'));
        const drafts = S.records.filter(r => !r.journalDeleted && r.journalState === 'draft');
        if (drafts.length) root.append(button(`${drafts.length} 篇日记草稿，想看时再打开`, Journals.drafts, 'material-link'));
        if (materials.length) root.append(button(`${materials.length} 份资料已留在账单，点此查看`, () => { S.page = 'bills'; render(); }, 'material-link'));
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
        const eventDays = [...new Set(S.transactions.filter(t => !t.deleted && t.status === 'confirmed' && J.linked(record, t) && C.date(t.occurredAt)).map(t => t.occurredAt.slice(0, 10)))].sort();
        if (eventDays.length && (eventDays.length > 1 || eventDays[0] !== C.dayKey(record.time))) root.append(node('p', 'muted', '关联交易发生于 ' + eventDays[0] + (eventDays.length > 1 ? ' 至 ' + eventDays.at(-1) : '') + '，账单按发生时间归入月份。'));
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
                        const candidate = C.normalize(raw, sourceId, index);
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
                        for (const t of candidates) {
                            const pref = state.meta.find(m => m.key === 'category:' + t.merchant.trim().toLowerCase());
                            if (pref && C.CATEGORIES.includes(pref.value)) { t.category = pref.value; t.categoryTentative = false; }
                        }
                        const merged = C.ingest(state.transactions, candidates);
                        const attempts = [...(latest.attempts || []), { at: new Date().toISOString(), token, extractedCount: candidates.length, linked: merged.linked }];
                        return { transactions: merged.transactions, imports: [{ id: sourceId, status: 'done', documentKind: C.documentKind(data), finishedAt: new Date().toISOString(), totals: data.totals, warnings, extractedCount: candidates.length, linked: merged.linked, attempts }] };
                    });
                    await routeSource(sourceId, C.documentKind(data));
                    toast(candidates.length ? `已整理 ${candidates.length} 笔候选，账单里可以查看。` : data.totals.length ? '已留下期间汇总，不与明细重复相加。' : '这份生活记录没有识别到交易。');
                } catch (error) {
                    await DB.changeLedger(state => {
                        const latest = state.imports.find(i => i.id === sourceId);
                        return !latest || latest.token !== token ? {} : { imports: [{ ...latest, status: 'failed', error: error.message, errorCode: error.code || '', requestId: error.requestId || '', failedAt: new Date().toISOString() }] };
                    });
                }
            });
        } catch (error) { report(error); }
        finally { runningBills.delete(sourceId); await refresh().catch(report); scheduleReflections(); Journals.offer(sourceId); }
    }
    function renderBills() {
        const root = $('billsPage'); root.replaceChildren();
        const heading = node('div', 'page-intro'); heading.append(node('h2', '', '生活账本'), node('p', 'muted', '一笔一笔，留下生活的踪迹。')); root.append(heading);
        const bookBar = node('div', 'month-bar'), bookSelect = node('select'); bookSelect.setAttribute('aria-label', '账本范围');
        for (const book of [{ id: 'all', name: '全部账本' }, ...books()]) { const option = node('option', '', book.name); option.value = book.id; bookSelect.append(option); }
        bookSelect.value = S.book;
        bookSelect.addEventListener('change', () => { S.book = bookSelect.value; S.selected.clear(); S.category = ''; renderBills(); });
        bookBar.append(bookSelect, button('管理账本', manageBooks)); root.append(bookBar);
        const scoped = C.inBook(S.transactions, S.book);
        const months = [...new Set([C.dayKey().slice(0, 7), S.month, ...S.transactions.filter(t => C.date(t.occurredAt)).map(t => t.occurredAt.slice(0, 7))])].sort().reverse();
        const bar = node('div', 'month-bar'), month = node('select'); month.setAttribute('aria-label', '账单月份');
        months.forEach(m => { const option = node('option', '', m.replace('-', ' 年 ') + ' 月'); option.value = m; month.append(option); }); month.value = S.month;
        month.addEventListener('change', () => { S.month = month.value; S.category = ''; S.selected.clear(); renderBills(); });
        bar.append(month, button(S.hideAmounts ? '显示金额' : '隐藏金额', async () => {
            S.hideAmounts = !S.hideAmounts; renderBills();
            try { await DB.put('meta', { key: 'hideAmounts', value: S.hideAmounts }); } catch (error) { report(error); }
        })); root.append(bar);
        let totals;
        try { totals = C.summary(scoped, S.month); } catch (error) { root.append(node('p', 'muted', error.message)); return; }
        const currencies = [...new Set([...Object.keys(totals.currencies), ...scoped.filter(t => !t.deleted && (!C.date(t.occurredAt) || t.occurredAt.startsWith(S.month)) && t.currency in C.DIGITS).map(t => t.currency)])];
        if (!currencies.includes(S.currency)) S.currency = currencies[0] || 'CNY';
        if (currencies.length > 1) {
            const select = node('select'); select.setAttribute('aria-label', '账单币种');
            currencies.forEach(c => { const option = node('option', '', c); option.value = c; select.append(option); }); select.value = S.currency;
            select.addEventListener('change', () => { S.currency = select.value; renderBills(); }); root.append(select, node('p', 'muted', '不同币种分别记录，不自动折算。'));
        }
        const total = totals.currencies[S.currency] || { income: 0, expense: 0, refund: 0, net: 0, categories: {} };
        const overview = node('section', 'bill-overview'); overview.dataset.testid = 'overview';
        const numbers = node('div', 'money-grid');
        for (const [title, label, value] of [['收到的', '已记录收入', total.income], ['花出去的', '已记录支出', total.expense]]) {
            const block = node('div'); block.append(node('p', 'metric-label', title), node('strong', 'metric-value', amount(value, S.currency)), node('p', 'muted', label)); numbers.append(block);
        }
        overview.append(numbers);
        if (total.refund) overview.append(node('p', 'muted', '退回的 ' + amount(total.refund, S.currency) + ' · 扣除退款 ' + amount(total.net, S.currency)));
        overview.append(node('p', 'muted cutoff', totals.latest ? '已入账交易截至 ' + totals.latest : '还没有已入账交易。'));
        overview.append(node('p', 'muted small', '这里汇总的是已经留下的记录，不代表完整账单。'));
        if (totals.reviews) overview.append(button(`还有 ${totals.reviews} 笔，等你有空看看`, () => { S.filter = 'review'; S.category = ''; renderBills(); }, 'review-link'));
        root.append(overview);
        if (S.book !== 'all') root.append(button('导出这个账本的本月明细 CSV', () => exportCSV({ book: S.book, month: S.month })));
        if (Object.keys(total.categories).length) {
            const section = node('section', 'bill-section'); section.append(node('h3', '', '钱花在哪里'));
            const categories = node('div', 'category-list');
            Object.entries(total.categories).sort((a, b) => b[1] - a[1]).forEach(([cat, value]) => categories.append(button(cat + ' · ' + amount(value, S.currency), () => { S.category = S.category === cat ? '' : cat; S.filter = 'all'; renderBills(); }, 'category-chip' + (S.category === cat ? ' selected' : ''))));
            section.append(categories); root.append(section);
        }
        const tasksPanel = node('details', 'source-tasks');
        const running = S.imports.filter(i => ['running', 'failed'].includes(i.status));
        const notes = S.imports.filter(i => i.status === 'done' && ((i.warnings || []).length || (i.totals || []).some(t => t.scope === 'period')));
        if (running.length || notes.length) {
            tasksPanel.open = running.some(job => job.status === 'failed');
            tasksPanel.append(node('summary', '', running.length ? `资料整理 · ${running.length} 份处理中或待重试` : '来源汇总与识别说明'));
            running.forEach(job => {
                const item = node('div', 'task-item'); item.append(node('p', 'muted', job.status === 'running' ? '正在整理一份资料…' : job.error));
                if (job.status === 'failed') item.append(button('重试这份资料', () => { void runBills(job.id, true); }));
                item.append(button('查看来源', () => showSource(job.id)));
                if (job.errorCode) item.append(node('p', 'muted small', [job.errorCode, job.requestId].filter(Boolean).join(' · '))); tasksPanel.append(item);
            });
            notes.forEach(job => {
                const item = node('div', 'task-item');
                for (const text of job.warnings || []) item.append(node('p', 'muted', text));
                for (const t of (job.totals || []).filter(t => t.scope === 'period')) item.append(node('p', 'muted', '来源期间汇总：' + (t.period || '期间未注明') + ' · ' + (S.hideAmounts ? '••••' : t.currency + ' ' + t.amount) + '（仅供核对，不叠加）'));
                item.append(button('查看来源', () => showSource(job.id))); tasksPanel.append(item);
            }); root.append(tasksPanel);
        }
        const list = node('section', 'bill-section'); list.append(node('h3', '', '一笔笔日常'));
        const filters = node('div', 'filter-bar');
        [['all', '全部'], ['review', '待核对'], ['deleted', '已移除']].forEach(([value, label]) => filters.append(button(label, () => { S.filter = value; renderBills(); }, 'filter-button' + (S.filter === value ? ' selected' : '')))); list.append(filters);
        if (S.category) list.append(button('当前分类：' + S.category + ' ×', () => { S.category = ''; renderBills(); }));
        const rows = scoped.filter(t => (S.filter === 'deleted' ? t.deleted : !t.deleted) && (S.filter !== 'review' || t.status !== 'confirmed') &&
            (!C.date(t.occurredAt) || t.occurredAt.startsWith(S.month)) && (!C.date(t.occurredAt) || t.currency === S.currency || !(t.currency in C.DIGITS)) && (!S.category || t.category === S.category))
            .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || '') || b.id.localeCompare(a.id));
        for (const selected of S.selected) if (!rows.some(t => t.id === selected)) S.selected.delete(selected);
        list.append(button(S.batchMode ? '结束批量整理' : '批量整理归属', () => { S.batchMode = !S.batchMode; S.selected.clear(); renderBills(); }));
        if (S.batchMode) {
            list.append(button('选择当前列表全部', () => { rows.forEach(t => S.selected.add(t.id)); renderBills(); }));
            const target = selectField(S.book === 'all' ? 'daily' : S.book, books().map(b => [b.id, b.name]), '批量移入账本', list);
            list.append(button('移动已选记录（' + S.selected.size + '）', async () => {
                try { if (!S.selected.size) { toast('先选择需要整理的交易。'); return; } await moveToBook([...S.selected], target.value); S.selected.clear(); await refresh(); toast('归属已更新，没有复制交易。'); }
                catch (error) { report(error); }
            }));
        }
        if (!rows.length) list.append(node('p', 'muted empty-bills', S.filter === 'review' ? '暂时没有需要核对的记录。' : '账单、照片，或一句话，都可以从“留下此刻”开始。'));
        let previousDay;
        for (const t of rows) {
            const day = C.date(t.occurredAt) ? t.occurredAt.slice(0, 10) : '日期待核对';
            if (day !== previousDay) { list.append(node('p', 'bill-day', day)); previousDay = day; }
            const row = button('', () => openTransaction(t.id), 'bill-row'); row.dataset.transactionId = t.id;
            const left = node('div'); left.append(node('strong', 'merchant-name', C.merchantLabel(t)), node('p', 'muted', t.category + (t.subcategory ? ' · ' + t.subcategory : '') + (S.book === 'all' ? ' · ' + bookName(t.bookId) : '') + (t.status !== 'confirmed' ? ' · 待核对' : t.confirmation === 'user' ? ' · 已由你确认' : '')));
            const right = node('div', 'bill-row-right'); right.append(node('span', '', ({ expense: '− ', income: '+ ', refund: '退回 ', transfer: '转账 ' }[t.direction] || '') + amount(t.amountMinor, t.currency)), node('p', 'muted', C.date(t.occurredAt) && t.precision === 'time' ? t.occurredAt.slice(11) : ''));
            row.append(left, right);
            if (S.batchMode) { const wrap = node('div', 'bill-selection'); const check = node('input'); check.type = 'checkbox'; check.checked = S.selected.has(t.id); check.setAttribute('aria-label', '选择交易 ' + t.id); check.addEventListener('change', () => { if (check.checked) S.selected.add(t.id); else S.selected.delete(t.id); renderBills(); }); wrap.append(check, row); list.append(wrap); }
            else list.append(row);
        }
        root.append(list);
        if (S.book === 'all') renderReflections(root);
        renderMaterials(root);
    }
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
    function renderMaterials(root) {
        const material = S.records.filter(r => !r.journalDeleted && r.journalState !== 'draft' && (['pending', 'bills'].includes(r.placement) || !r.placementUser && C.onTimeline(r) && (r.sourceIds || []).some(sid => S.imports.some(job => job.id === sid && (job.documentKind === 'bill' || job.extractedCount > 0)))))
            .sort((a, b) => b.time.localeCompare(a.time));
        if (!material.length) return;
        const tray = node('details', 'materials'); tray.append(node('summary', '', '已上传资料 · ' + material.length + ' 条'));
        const appendRecord = (target, r) => {
            const box = node('div', 'material-item'); box.append(node('p', '', r.placement === 'pending' ? '资料已保存，去向待选择' : C.onTimeline(r) ? '已有记录 · 可选择仅留账单' : '账单资料 · 未在时光展示'), node('p', 'muted', new Date(r.time).toLocaleString()));
            if (imageOK(r.image)) { const img = node('img', 'material-thumb'); img.src = r.image; img.alt = '来源缩略图'; img.loading = 'lazy'; box.append(img); }
            box.append(button('查看这份记录', () => openRecord(r.id)), button('选择日记方式', () => { void Journals.choose(r.sourceIds || []); }));
            box.append(button(C.onTimeline(r) ? '仅保留到账单' : '也想留下这一刻', () => { if (C.onTimeline(r)) void placeRecord(r.id, 'bills'); else if (r.timelineHidden || r.placement === 'pending') void placeRecord(r.id, 'journal'); else void Journals.choose(r.sourceIds || []); }));
            target.append(box);
        };
        material.slice(0, 6).forEach(r => appendRecord(tray, r));
        if (material.length > 6) tray.append(button('查看全部资料', () => { const body = modal('全部已上传资料'); material.forEach(r => appendRecord(body, r)); }));
        root.append(tray);
    }
    function field(root, label, element) {
        const wrap = node('div', 'form-field'), name = node('label', '', label);
        element.id = 'field-' + id(); name.htmlFor = element.id;
        wrap.append(name, element); root.append(wrap); return element;
    }
    function input(value, label, root) { const e = node('input'); e.value = value || ''; return field(root, label, e); }
    function selectField(value, entries, label, root) {
        const e = node('select'); entries.forEach(([key, text]) => { const option = node('option', '', text); option.value = key; e.append(option); }); e.value = value; return field(root, label, e);
    }
    function openTransaction(transactionId) {
        const t = S.transactions.find(t => t.id === transactionId); if (!t) return;
        const root = modal(t.status === 'confirmed' ? '这一笔' : '一起核对这一笔');
        root.append(node('p', 'muted', t.entryMethod==='text'?'来源：手动记录 · 原话可查；未经支付平台验证'+(t.paymentMethod?' · '+t.paymentMethod:''):t.confirmation === 'user' ? '已由你确认／修改' : t.status === 'confirmed' ? '通过自动校验 · 随时可以修改' : '原始资料已保留，尚未计入累计。'));
        root.append(button(t.deleted ? '恢复为待核对记录' : '从账本移除，保留原始资料', async () => {
            try {
                await DB.changeLedger(state => { const latest = state.transactions.find(x => x.id === t.id); return { transactions: [C.edit(latest, t.deleted ? { deleted: false, status: 'review', reasons: ['已恢复，请重新核对'] } : { deleted: true }, t.deleted ? '用户恢复' : '用户移除')] }; });
                await refresh(); closeModal(); toast(t.deleted ? '已恢复为待核对记录。' : '已从累计移除，仍可在“已移除”中找到。'); scheduleReflections();
            } catch (error) { report(error); }
        }));
        if (t.refundOf && S.transactions.some(other => other.id === t.refundOf)) root.append(button('查看退款对应的原消费', () => openTransaction(t.refundOf)));
        S.transactions.filter(other => !other.deleted && other.refundOf === t.id).forEach(other => root.append(button('查看关联退款 · ' + amount(other.amountMinor, other.currency), () => openTransaction(other.id))));
        if (t.reasons.length || t.proposal) root.append(node('p', 'review-note', S.hideAmounts?'有些字段待核对，展开编辑后可以查看。':[...t.reasons, t.proposal].filter(Boolean).join('；')));
        const duplicate = S.transactions.find(other => other.id === t.duplicateOf);
        if (duplicate) {
            root.append(node('p', 'review-note', '可能对应已有记录：' + (duplicate.merchant || '交易') + ' · ' + amount(duplicate.amountMinor, duplicate.currency) + ' · ' + duplicate.occurredAt));
            root.append(button('查看可能重复的记录', () => openTransaction(duplicate.id)));
            root.append(button('确认是同一笔，合并来源', async () => {
                try {
                    await DB.changeLedger(state => {
                        const a = state.transactions.find(x => x.id === t.id), b = state.transactions.find(x => x.id === duplicate.id);
                        if (!a || !b) throw Error('记录已变化，请刷新后核对。');
                        return { transactions: [C.edit(b, { sourceIds: [...new Set([...b.sourceIds, ...a.sourceIds])] }, '用户合并来源'), C.edit(a, { deleted: true, mergedInto: b.id }, '用户确认同一笔')] };
                    });
                    await refresh(); closeModal(); toast('来源已合并，只按保留的交易计入。'); scheduleReflections();
                } catch (error) { report(error); }
            }));
        }
        const form = node('form', 'bill-form'); form.addEventListener('submit', e => e.preventDefault());
        const merchant = input(t.merchant, '商户初始识别结果（保留）', form); merchant.readOnly = true;
        const displayName = input(C.merchantLabel(t), '列表简称 · 不改变来源原名', form); displayName.maxLength = 100;
        const paymentMethod=selectField(t.paymentMethod||'', [['','未注明'],['现金','现金'],['微信','微信'],['支付宝','支付宝']], '支付方式', form);
        const date = input(t.occurredAt, '交易发生时间', form); date.placeholder = '2026-10-25 或 2026-10-25 12:30';
        const currency = selectField(t.currency in C.DIGITS ? t.currency : '', [['', '请选择币种'], ...Object.keys(C.DIGITS).map(c => [c, c])], '币种', form);
        const value = input(t.amountMinor !== null && t.currency in C.DIGITS ? C.decimal(t.amountMinor, t.currency) : t.proposedAmount, '金额（非负）', form); value.inputMode = 'decimal';
        const direction = selectField(t.direction, [['unknown', '需要确认'], ['expense', '支出'], ['income', '收入'], ['refund', '退款'], ['transfer', '本人账户间转账']], '收支方向', form);
        const paid = selectField(t.paymentState, [['paid', '已完成'], ['pending', '待支付／处理中'], ['closed', '已关闭／失败'], ['unknown', '需要确认']], '交易状态', form);
        const category = selectField(t.category, C.CATEGORIES.map(c => [c, c]), '生活归类 · 可以调整', form);
        const subcategory = input(t.subcategory, '细分用途 · 暂定，可留空', form); subcategory.maxLength = 30; subcategory.placeholder = '如：充电宝、咖啡、打车';
        const book = selectField(C.bookOf(t), books().map(b => [b.id, b.name]), '归属账本', form);
        if (/倍电/.test(t.merchant) && t.category === '其他') form.append(button('建议归为：生活服务 · 充电宝', () => { category.value = '生活服务'; subcategory.value = '充电宝'; }));
        const tags = input(t.tags.join('、'), '生活标签 · 暂定，可修改或留空', form); tags.maxLength = 120;
        const learn = node('input'); learn.type = 'checkbox'; learn.checked = false;
        const learnLabel = node('label', 'check-label'); learnLabel.append(learn, node('span', '', '以后遇到这个商户，优先使用此类别（不修改历史）')); form.append(learnLabel);
        let separate;
        if (duplicate) { separate = node('input'); separate.type = 'checkbox'; const label = node('label', 'check-label'); label.append(separate, node('span', '', '我确认这是另外一笔真实交易')); form.append(label); }
        const errorBox = node('p', 'form-error'); errorBox.setAttribute('role', 'status'); form.append(errorBox);
        const save = async confirm => {
            try {
                const amountMinor = C.money(value.value, currency.value), occurred = C.date(date.value);
                if (confirm && (amountMinor === null || !occurred || occurred.timestamp > Date.now() + 300000 || direction.value === 'unknown' || paid.value !== 'paid')) throw Error('请核对金额、币种、完整日期、收支方向，并确认交易已经完成。');
                if (confirm && duplicate && !separate.checked) throw Error('请先判断是否与已有交易为同一笔。');
                const changes = { paymentMethod:paymentMethod.value,merchant: t.merchant, displayName: displayName.value.trim().slice(0, 100), correctedMerchant: merchant.value.trim().slice(0, 100), subcategory: subcategory.value.trim().slice(0, 30), bookId: book.value, bookManuallySet: !!t.bookManuallySet || book.value !== C.bookOf(t), occurredAt: occurred ? occurred.value : date.value.trim(), precision: occurred ? occurred.precision : 'unknown',
                    amountMinor, proposedAmount: value.value, currency: currency.value, direction: direction.value, paymentState: paid.value, category: category.value,
                    categoryTentative: false, tags: [...new Set(tags.value.split(/[、,，]/).map(s => s.trim().slice(0, 20)).filter(Boolean))].slice(0, 5),
                    status: confirm ? 'confirmed' : 'review', confirmation: confirm ? 'user' : '', reasons: confirm ? [] : ['已保存修改，等待确认'], deleted: false };
                if (confirm) changes.duplicateOf = null;
                await DB.changeLedger(state => {
                    const latest = state.transactions.find(x => x.id === t.id); if (!latest) throw Error('这笔记录不存在。');
                    return { transactions: [C.edit(latest, changes, confirm ? '用户确认并入账' : '用户保存待核对修改'), ...state.transactions.filter(other => other.refundOf === t.id && !other.bookManuallySet && changes.bookId !== C.bookOf(latest)).map(other => C.edit(other, { bookId: changes.bookId }, '跟随原消费调整账本'))],
                        meta: learn.checked && t.merchant ? [{ key: 'category:' + t.merchant.toLowerCase(), value: changes.category }] : [] };
                });
                await refresh(); closeModal(); toast(confirm ? '已更新这一笔，累计也已重新计算。' : '修改已保存，尚未计入累计。'); scheduleReflections();
            } catch (error) { errorBox.textContent = error.message; }
        };
        form.append(button('确认并入账', () => { void save(true); }, 'primary-button'), button('先保存修改，稍后确认', () => { void save(false); })); if(S.hideAmounts){form.hidden=true;root.append(button('编辑这一笔（显示真实金额）',()=>{form.hidden=false;}));} root.append(form);
        root.append(node('h3', 'detail-label', '每一笔，都有来处'));
        t.sourceIds.forEach(sid => root.append(button('查看来源原图／文字', () => showSource(sid))));
        S.records.filter(r => !r.journalDeleted && J.linked(r, t)).forEach(r => root.append(button('查看关联的生活记录', () => openRecord(r.id))));
        const details = node('details'); details.append(node('summary', 'muted', '来源摘录与修改记录'));
        details.append(node('p', 'muted small', Object.entries(t.evidence).filter(([, v]) => v).map(([k, v]) => k + '：' + v).join('\n')));
        for (const h of t.history || []) details.append(node('p', 'muted small', new Date(h.at).toLocaleString() + ' · ' + h.action)); root.append(details);

    }

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
            jobs = C.reflectionJobs(S.transactions, S.records.filter(r => r.aiAllowed === true && C.onTimeline(r)), existing, C.dayKey(), manualIds ? Number.MAX_SAFE_INTEGER : 6);
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
            const hasData = S.transactions.some(t => !t.deleted && t.status === 'confirmed' && (t.occurredAt || '').startsWith(r.id)) || S.records.some(note => note.aiAllowed === true && C.onTimeline(note) && J.day(note).startsWith(r.id));
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
            const rows = C.inBook(await DB.getAll('transactions'), options.book || 'all').filter(t => (!t.deleted||options.includeDeleted) && (!options.month || (t.occurredAt || '').startsWith(options.month)));
            const cell = value => '"' + String(value == null ? '' : value).replace(/^(?:\s*[=+\-@]|[\t\r])/, s => "'" + s).replace(/"/g, '""') + '"';
            const table = [['编号', '发生时间', '来源商户', '展示简称', '细分用途', '账本', '方向', '金额', '币种', '类别', '标签', '状态', '已移除', '来源编号', '支付方式', '录入方式'], ...rows.map(t => [t.id, t.occurredAt, t.merchant, C.merchantLabel(t), t.subcategory || '', bookName(t.bookId), t.direction, t.amountMinor === null || !(t.currency in C.DIGITS) ? t.proposedAmount : C.decimal(t.amountMinor, t.currency), t.currency, t.category, t.tags.join('、'), t.status, t.deleted ? '是' : '否', t.sourceIds.join(';'),t.paymentMethod||'',t.entryMethod==='text'?'手动短句':'资料识别'])];
            download(new Blob(['\ufeff' + table.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'shijian-bills-' + C.dayKey() + '.csv');
        } catch (error) { report(error); }
    }
    function renderMine() { Mine.render(); }
    function render() {
        renderTimeline(); renderBills(); renderMine();
        $('timelineContainer').hidden = S.page !== 'timeline'; $('billsPage').hidden = S.page !== 'bills'; $('minePage').hidden = S.page !== 'mine';
        document.querySelectorAll('[data-page]').forEach(e => { e.classList.toggle('active', e.dataset.page === S.page); e.setAttribute('aria-current', e.dataset.page === S.page ? 'page' : 'false'); });
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
        $('currentMonth').textContent = new Date().getFullYear() + '年' + (new Date().getMonth() + 1) + '月';
        $('messageInput').addEventListener('input',Drafts.scheduleComposer);
        $('messageInput').addEventListener('input',previewQuickBill);
        $('recordIntent').addEventListener('change',previewQuickBill);
        $('useAI').addEventListener('change',previewQuickBill);
        for(const key of ['recordIntent','uploadBook','useAI'])$(key).addEventListener('change',Drafts.scheduleComposer);
        const draftStatus=node('p','muted');draftStatus.id='inputDraftStatus';$('draftImages').after(draftStatus);
        $('imageInput').addEventListener('change', onImages); $('exportButton').addEventListener('click', exportData);
        document.querySelectorAll('[data-page]').forEach(e => e.addEventListener('click', () => { S.previousPage=S.page; S.page = e.dataset.page; render(); }));
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
