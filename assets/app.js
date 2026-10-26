/* 拾间应用层：输入、生活记录、账单视图分别组织；金额与去重交给 LedgerCore。 */
(function () {
    'use strict';
    const C = window.LedgerCore, DB = window.ShijianStorage;
    const S = { records: [], sources: [], transactions: [], imports: [], reflections: [], meta: [], drafts: [], ready: false, saving: false, imageLoading: false,
        page: 'timeline', month: C.dayKey().slice(0, 7), currency: 'CNY', filter: 'all', category: '', hideAmounts: false, autoAI: true };
    const $ = id => document.getElementById(id);
    const id = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const button = (text, fn, cls = 'quiet-button') => { const e = node('button', cls, text); e.type = 'button'; e.addEventListener('click', fn); return e; };
    const imageOK = s => typeof s === 'string' && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(s);
    const currentRecord = key => S.records.find(r => r.id === key);
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
        toast(text);
    }
    async function refresh() { Object.assign(S, await DB.snapshot(false)); render(); }
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
        $('saveButton').disabled = !S.ready || S.saving || S.imageLoading;
        $('saveButton').textContent = S.saving ? '保存中…' : S.imageLoading ? '图片处理中…' : '保存';
    }
    function renderDrafts() {
        const root = $('draftImages'); root.replaceChildren();
        S.drafts.forEach((draft, index) => {
            const box = node('div', 'draft-thumb'); const img = node('img'); img.src = draft.preview; img.alt = '待保存图片 ' + (index + 1);
            box.append(img, button('移除', () => { S.drafts.splice(index, 1); renderDrafts(); })); root.append(box);
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
            renderDrafts();
        } catch (error) { report(error); }
        finally { S.imageLoading = false; updateSaveButton(); }
    }
    function openInputPanel() {
        $('inputPanel').classList.add('show'); $('inputOverlay').classList.add('show');
        $('inputPanel').setAttribute('aria-hidden', 'false'); document.body.classList.add('panel-open');
    }
    function closeInputPanel() {
        if (S.saving) return;
        $('inputPanel').classList.remove('show'); $('inputOverlay').classList.remove('show');
        $('inputPanel').setAttribute('aria-hidden', 'true'); document.body.classList.remove('panel-open'); $('messageInput').blur();
    }
    async function saveRecord() {
        if (!S.ready || S.saving || S.imageLoading) return;
        const text = $('messageInput').value.trim();
        if (!text && !S.drafts.length) { toast('一句话，或一张图片，都可以。'); return; }
        S.saving = true; updateSaveButton();
        const now = new Date().toISOString(), batchId = id(), useAI = $('useAI').checked;
        const records = [], sources = [];
        try {
            const drafts = S.drafts.length ? S.drafts : [null];
            for (let i = 0; i < drafts.length; i++) {
                const draft = drafts[i], recordId = id(), sourceId = draft ? draft.id : 'text-' + recordId;
                const record = { id: recordId, batchId, time: now, text: i === 0 ? text : '', image: draft ? draft.preview : null,
                    sourceIds: [sourceId], ai: '', aiStatus: useAI ? 'queued' : 'idle', error: '', aiAllowed: useAI };
                records.push(record);
                sources.push({ ...(draft || {}), id: sourceId, recordIds: [recordId], text: record.text, uploadedAt: now, batchId, kind: draft ? 'image' : 'text' });
            }
            await DB.saveBatch(records, sources);
            $('messageInput').value = ''; S.drafts = []; renderDrafts();
            S.saving = false; closeInputPanel(); await refresh(); toast(useAI ? '已保存在此设备，正在轻轻整理。' : '已保存在此设备，未发送给AI。');
            if (useAI) {
                records.forEach(record => { void runJournal(record.id); });
                for (const source of sources) if (source.preview || /[¥￥$元]|支出|收入|花了|付款|退款/.test(source.text)) void runBills(source.id);
            }
        } catch (error) { notice('本次保存未完成，输入仍保留。请检查设备存储并导出已有记录。'); report(error); }
        finally { S.saving = false; updateSaveButton(); }
    }

    // 日记模块：只按最新记录合并 AI 结果，用户编辑后的正文绝不被迟到回复覆盖。
    async function runJournal(recordId) {
        if (runningJournal.has(recordId)) return;
        runningJournal.add(recordId);
        try {
            await queue(async () => {
                const record = await DB.get('records', recordId); if (!record) return;
                await DB.updateRecord(recordId, old => ({ ...old, aiStatus: 'generating', error: '' })); await refresh();
                try {
                    const data = await post('/api/chat', message(record.text, record.image), 65000);
                    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
                    if (typeof text !== 'string' || !text.trim()) throw Error('这次没有整理出文字，原始记录仍在。');
                    await DB.updateRecord(recordId, old => ({ ...old, ...(old.journalEdited ? { aiCandidate: text.trim() } : { ai: text.trim() }), aiStatus: 'done', error: '', errorCode: '', requestId: '' }));
                } catch (error) {
                    await DB.updateRecord(recordId, old => ({ ...old, aiStatus: 'failed', error: error.message, errorCode: error.code || '', requestId: error.requestId || '' }));
                }
            });
        } catch (error) { notice('原始记录已保留，但整理状态未能写入设备，请先导出备份。'); }
        finally { runningJournal.delete(recordId); await refresh().catch(report); }
    }
    function renderTimeline() {
        const root = $('timelineContainer'); root.replaceChildren();
        const grouped = new Map();
        [...S.records].sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id)).forEach(r => { const d = C.dayKey(r.time); if (!grouped.has(d)) grouped.set(d, []); grouped.get(d).push(r); });
        if (!grouped.size) { root.append(node('p', 'empty-state', '这里，留给你的日常。')); return; }
        for (const [day, records] of grouped) {
            const group = node('section', 'day-group'), date = node('div', 'date-side'), track = node('div', 'timeline-track'), content = node('div', 'content-side');
            date.append(node('div', 'date-num', day.slice(8)), node('div', 'date-month', +day.slice(5, 7) + '月')); track.append(node('div', 'dot'));
            for (const record of records) {
                const card = node('article', 'record-item'); card.dataset.recordId = record.id; card.tabIndex = 0; card.setAttribute('role', 'button');
                card.append(node('h3', 'content-title', (record.text || (record.image ? '一张生活切片' : '时光切片')).split('\n')[0].slice(0, 20)));
                if (imageOK(record.image)) { const img = node('img', 'content-image'); img.src = record.image; img.alt = '记录图片'; img.loading = 'lazy'; card.append(img); }
                card.append(node('p', 'content-text', record.ai || record.text || '图片已留下，点开看看。'));
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
        const root = $('modalContent'); root.replaceChildren(); const card = node('div', 'detail-card'); card.append(node('h2', 'detail-title', title)); root.append(card);
        $('detailModal').classList.add('show'); $('detailModal').scrollTop = 0; return card;
    }
    function closeModal() { $('detailModal').classList.remove('show'); }
    async function showSource(sourceId) {
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
        const eventDays = [...new Set(S.transactions.filter(t => !t.deleted && t.status === 'confirmed' && (record.sourceIds || []).some(sid => t.sourceIds.includes(sid)) && C.date(t.occurredAt)).map(t => t.occurredAt.slice(0, 10)))].sort();
        if (eventDays.length && (eventDays.length > 1 || eventDays[0] !== C.dayKey(record.time))) root.append(node('p', 'muted', '关联交易发生于 ' + eventDays[0] + (eventDays.length > 1 ? ' 至 ' + eventDays.at(-1) : '') + '，账单按发生时间归入月份。'));
        if (imageOK(record.image)) { const img = node('img', 'detail-image'); img.src = record.image; img.alt = '记录图片'; root.append(img); }
        if (record.text) root.append(node('p', 'detail-label', '当时留下的话'), node('p', 'detail-text', record.text));
        const text = node('textarea', 'journal-editor'); text.value = record.ai || ''; text.maxLength = 8000; text.setAttribute('aria-label', '编辑时光切片'); text.placeholder = '这里也可以用自己的话写。';
        root.append(node('p', 'detail-label', '属于你的文字，可以反复修改'), text);
        root.append(button('保存文字', async () => {
            try {
                await DB.updateRecord(recordId, old => ({ ...old, ai: text.value, journalEdited: true, journalHistory: [...(old.journalHistory || []), { at: new Date().toISOString(), before: old.ai || '', after: text.value }] }));
                await refresh(); toast('已留下你的表达。'); scheduleReflections();
            } catch (error) { report(error); }
        }, 'primary-button'));
        if (record.aiCandidate) {
            root.append(node('p', 'detail-label', 'AI另一个版本 · 不会覆盖你的文字'), node('p', 'detail-text', record.aiCandidate));
            root.append(button('采用这个版本', async () => {
                try { await DB.updateRecord(recordId, old => ({ ...old, ai: old.aiCandidate, aiCandidate: '', journalEdited: true, journalHistory: [...(old.journalHistory || []), { at: new Date().toISOString(), before: old.ai || '', after: old.aiCandidate }] })); await refresh(); openRecord(recordId); }
                catch (error) { report(error); }
            }));
        }
        root.append(button('重新整理文字', () => { void runJournal(recordId); toast('已安排整理，保留你已修改的版本。'); }));
        if (record.error) root.append(node('p', 'muted', record.error));
        for (const sid of record.sourceIds || []) root.append(button('查看来源原图／文字', () => showSource(sid)));
        const bills = S.transactions.filter(t => !t.deleted && (record.sourceIds || []).some(sid => t.sourceIds.includes(sid)));
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
                if (old && old.status === 'done' && !retry) { toast('这份账单来源已经整理，不会重复计入。'); return; }
                const token = id();
                const claim = await DB.changeLedger(state => {
                    const latest = state.imports.find(i => i.id === sourceId);
                    if (latest && (latest.status === 'done' && !retry || latest.status === 'running' && Date.now() - Date.parse(latest.startedAt || 0) < 130000)) return { claimed: false };
                    return { claimed: true, reprocess: !!latest && latest.extractedCount !== undefined, imports: [{ ...(latest || {}), id: sourceId, token, status: 'running', startedAt: new Date().toISOString(), error: '' }] };
                });
                if (!claim.claimed) { toast('这份来源已经在整理或已完成，不会重复提交。'); return; }
                await refresh();
                try {
                    const data = await post('/api/bills/extract', message(source.text, source.preview));
                    if (!Array.isArray(data.transactions) || !Array.isArray(data.totals)) throw Error('账单返回格式不完整，尚未入账。');
                    const candidates = data.transactions.map((raw, index) => {
                        const candidate = C.normalize(raw, sourceId, index);
                        // 显式重新识别保留已有交易；新候选重新走去重与核对，不能覆盖用户的修改。
                        if (claim.reprocess) candidate.id = sourceId + ':attempt:' + token + ':row:' + index;
                        return candidate;
                    });
                    const warnings = [...(Array.isArray(data.warnings) ? data.warnings : []), ...C.checkTotals(candidates, data.totals)];
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
                        return { transactions: merged.transactions, imports: [{ id: sourceId, status: 'done', finishedAt: new Date().toISOString(), totals: data.totals, warnings, extractedCount: candidates.length, linked: merged.linked, attempts }] };
                    });
                    toast(candidates.length ? `已整理 ${candidates.length} 笔候选，账单里可以查看。` : data.totals.length ? '已留下期间汇总，不与明细重复相加。' : '这份生活记录没有识别到交易。');
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
    function renderBills() {
        const root = $('billsPage'); root.replaceChildren();
        const heading = node('div', 'page-intro'); heading.append(node('h2', '', '生活账本'), node('p', 'muted', '一笔一笔，留下生活的踪迹。')); root.append(heading);
        const months = [...new Set([C.dayKey().slice(0, 7), S.month, ...S.transactions.filter(t => C.date(t.occurredAt)).map(t => t.occurredAt.slice(0, 7))])].sort().reverse();
        const bar = node('div', 'month-bar'), month = node('select'); month.setAttribute('aria-label', '账单月份');
        months.forEach(m => { const option = node('option', '', m.replace('-', ' 年 ') + ' 月'); option.value = m; month.append(option); }); month.value = S.month;
        month.addEventListener('change', () => { S.month = month.value; S.category = ''; renderBills(); });
        bar.append(month, button(S.hideAmounts ? '显示金额' : '隐藏金额', async () => {
            S.hideAmounts = !S.hideAmounts; renderBills();
            try { await DB.put('meta', { key: 'hideAmounts', value: S.hideAmounts }); } catch (error) { report(error); }
        })); root.append(bar);
        let totals;
        try { totals = C.summary(S.transactions, S.month); } catch (error) { root.append(node('p', 'muted', error.message)); return; }
        const currencies = [...new Set([...Object.keys(totals.currencies), ...S.transactions.filter(t => !t.deleted && (!C.date(t.occurredAt) || t.occurredAt.startsWith(S.month)) && t.currency in C.DIGITS).map(t => t.currency)])];
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
        if (Object.keys(total.categories).length) {
            const section = node('section', 'bill-section'); section.append(node('h3', '', '钱花在哪里'));
            const categories = node('div', 'category-list');
            Object.entries(total.categories).sort((a, b) => b[1] - a[1]).forEach(([cat, value]) => categories.append(button(cat + ' · ' + amount(value, S.currency), () => { S.category = S.category === cat ? '' : cat; S.filter = 'all'; renderBills(); }, 'category-chip' + (S.category === cat ? ' selected' : ''))));
            section.append(categories); root.append(section);
        }
        renderReflections(root);
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
        const rows = S.transactions.filter(t => (S.filter === 'deleted' ? t.deleted : !t.deleted) && (S.filter !== 'review' || t.status !== 'confirmed') &&
            (!C.date(t.occurredAt) || t.occurredAt.startsWith(S.month)) && (!C.date(t.occurredAt) || t.currency === S.currency || !(t.currency in C.DIGITS)) && (!S.category || t.category === S.category))
            .sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || '') || b.id.localeCompare(a.id));
        if (!rows.length) list.append(node('p', 'muted empty-bills', S.filter === 'review' ? '暂时没有需要核对的记录。' : '账单、照片，或一句话，都可以从“留下此刻”开始。'));
        let previousDay;
        for (const t of rows) {
            const day = C.date(t.occurredAt) ? t.occurredAt.slice(0, 10) : '日期待核对';
            if (day !== previousDay) { list.append(node('p', 'bill-day', day)); previousDay = day; }
            const row = button('', () => openTransaction(t.id), 'bill-row'); row.dataset.transactionId = t.id;
            const left = node('div'); left.append(node('strong', '', t.merchant || '一笔记录'), node('p', 'muted', t.category + (t.status !== 'confirmed' ? ' · 待核对' : t.confirmation === 'user' ? ' · 已由你确认' : '')));
            const right = node('div', 'bill-row-right'); right.append(node('span', '', ({ expense: '− ', income: '+ ', refund: '退回 ', transfer: '转账 ' }[t.direction] || '') + amount(t.amountMinor, t.currency)), node('p', 'muted', C.date(t.occurredAt) && t.precision === 'time' ? t.occurredAt.slice(11) : ''));
            row.append(left, right); list.append(row);
        }
        root.append(list);
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
        root.append(node('p', 'muted', t.confirmation === 'user' ? '已由你确认／修改' : t.status === 'confirmed' ? '通过自动校验 · 随时可以修改' : '原始资料已保留，尚未计入累计。'));
        if (t.refundOf && S.transactions.some(other => other.id === t.refundOf)) root.append(button('查看退款对应的原消费', () => openTransaction(t.refundOf)));
        S.transactions.filter(other => !other.deleted && other.refundOf === t.id).forEach(other => root.append(button('查看关联退款 · ' + amount(other.amountMinor, other.currency), () => openTransaction(other.id))));
        if (t.reasons.length || t.proposal) root.append(node('p', 'review-note', [...t.reasons, t.proposal].filter(Boolean).join('；')));
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
        const merchant = input(t.merchant, '商户／用途', form); merchant.maxLength = 100;
        const date = input(t.occurredAt, '交易发生时间', form); date.placeholder = '2026-10-25 或 2026-10-25 12:30';
        const currency = selectField(t.currency in C.DIGITS ? t.currency : '', [['', '请选择币种'], ...Object.keys(C.DIGITS).map(c => [c, c])], '币种', form);
        const value = input(t.amountMinor !== null && t.currency in C.DIGITS ? C.decimal(t.amountMinor, t.currency) : t.proposedAmount, '金额（非负）', form); value.inputMode = 'decimal';
        const direction = selectField(t.direction, [['unknown', '需要确认'], ['expense', '支出'], ['income', '收入'], ['refund', '退款'], ['transfer', '本人账户间转账']], '收支方向', form);
        const paid = selectField(t.paymentState, [['paid', '已完成'], ['pending', '待支付／处理中'], ['closed', '已关闭／失败'], ['unknown', '需要确认']], '交易状态', form);
        const category = selectField(t.category, C.CATEGORIES.map(c => [c, c]), '生活归类 · 可以调整', form);
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
                const changes = { merchant: merchant.value.trim().slice(0, 100), occurredAt: occurred ? occurred.value : date.value.trim(), precision: occurred ? occurred.precision : 'unknown',
                    amountMinor, proposedAmount: value.value, currency: currency.value, direction: direction.value, paymentState: paid.value, category: category.value,
                    categoryTentative: false, tags: [...new Set(tags.value.split(/[、,，]/).map(s => s.trim().slice(0, 20)).filter(Boolean))].slice(0, 5),
                    status: confirm ? 'confirmed' : 'review', confirmation: confirm ? 'user' : '', reasons: confirm ? [] : ['已保存修改，等待确认'], deleted: false };
                if (confirm) changes.duplicateOf = null;
                await DB.changeLedger(state => {
                    const latest = state.transactions.find(x => x.id === t.id); if (!latest) throw Error('这笔记录不存在。');
                    return { transactions: [C.edit(latest, changes, confirm ? '用户确认并入账' : '用户保存待核对修改')],
                        meta: learn.checked && changes.merchant ? [{ key: 'category:' + changes.merchant.toLowerCase(), value: changes.category }] : [] };
                });
                await refresh(); closeModal(); toast(confirm ? '已更新这一笔，累计也已重新计算。' : '修改已保存，尚未计入累计。'); scheduleReflections();
            } catch (error) { errorBox.textContent = error.message; }
        };
        form.append(button('确认并入账', () => { void save(true); }, 'primary-button'), button('先保存修改，稍后确认', () => { void save(false); })); root.append(form);
        root.append(node('h3', 'detail-label', '每一笔，都有来处'));
        t.sourceIds.forEach(sid => root.append(button('查看来源原图／文字', () => showSource(sid))));
        S.records.filter(r => (r.sourceIds || []).some(sid => t.sourceIds.includes(sid))).forEach(r => root.append(button('查看关联的生活记录', () => openRecord(r.id))));
        const details = node('details'); details.append(node('summary', 'muted', '来源摘录与修改记录'));
        details.append(node('p', 'muted small', Object.entries(t.evidence).filter(([, v]) => v).map(([k, v]) => k + '：' + v).join('\n')));
        for (const h of t.history || []) details.append(node('p', 'muted small', new Date(h.at).toLocaleString() + ' · ' + h.action)); root.append(details);
        root.append(button(t.deleted ? '恢复为待核对记录' : '从账本移除，保留原始资料', async () => {
            try {
                await DB.changeLedger(state => { const latest = state.transactions.find(x => x.id === t.id); return { transactions: [C.edit(latest, t.deleted ? { deleted: false, status: 'review', reasons: ['已恢复，请重新核对'] } : { deleted: true }, t.deleted ? '用户恢复' : '用户移除')] }; });
                await refresh(); closeModal(); toast(t.deleted ? '已恢复为待核对记录。' : '已从累计移除，仍可在“已移除”中找到。'); scheduleReflections();
            } catch (error) { report(error); }
        }));
    }

    // 回看模块：仅下一次唤醒时补做已结束期间，不通知，不填补空白日期。
    function scheduleReflections() {
        clearTimeout(reflectionTimer);
        if (!S.ready || !S.autoAI || activeTasks || tasks.length || reflectionRunning) return;
        reflectionTimer = setTimeout(() => { void runReflections(); }, 1800);
    }
    async function runReflections(manualIds) {
        if (reflectionRunning || !S.ready || (!S.autoAI && !manualIds)) return;
        reflectionRunning = true;
        let jobs = [];
        try {
            await refresh();
            const existing = manualIds ? S.reflections.filter(r => !manualIds.includes(r.id)) : S.reflections;
            jobs = C.reflectionJobs(S.transactions, S.records.filter(r => r.aiAllowed === true), existing, C.dayKey(), manualIds ? Number.MAX_SAFE_INTEGER : 6);
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
                const old = await DB.get('reflections', job.id);
                await DB.put('reflections', { ...old, id: job.id, ...(old && old.edited ? { candidate: item.text } : { text: item.text }), revision: job.revision, status: 'done', error: '', updatedAt: new Date().toISOString() });
            }
        } catch (error) {
            for (const job of jobs) {
                const old = await DB.get('reflections', job.id).catch(() => null);
                if (old) await DB.put('reflections', { ...old, status: 'failed', error: error.message }).catch(() => {});
            }
        } finally { reflectionRunning = false; await refresh().catch(report); }
    }
    function renderReflections(root) {
        const entries = S.reflections.filter(r => r.id.startsWith(S.month)).sort((a, b) => a.id.length - b.id.length || b.id.localeCompare(a.id));
        if (!entries.length) return;
        const section = node('section', 'bill-section'); section.append(node('h3', '', '这一月的片段'));
        entries.forEach(r => {
            const box = node('details', 'reflection'); box.append(node('summary', '', r.id.length === 7 ? '这一月，慢慢回看' : r.id.slice(5).replace('-', '月') + '日'));
            const hasData = S.transactions.some(t => !t.deleted && t.status === 'confirmed' && (t.occurredAt || '').startsWith(r.id)) || S.records.some(note => note.aiAllowed === true && C.dayKey(note.time).startsWith(r.id));
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
    async function exportData() {
        try {
            const data = await DB.snapshot(); let legacyRaw = null; try { legacyRaw = localStorage.getItem('shijian_history'); } catch (_) {}
            download(new Blob([JSON.stringify({ version: C.VERSION, exportedAt: new Date().toISOString(), ...data, legacyRaw }, null, 2)], { type: 'application/json' }), 'shijian-backup-' + C.dayKey() + '.json'); toast('已导出完整本机备份，包含来源资料。');
        } catch (error) { report(error); }
    }
    async function exportCSV() {
        try {
            const rows = await DB.getAll('transactions');
            const cell = value => '"' + String(value == null ? '' : value).replace(/^(?:\s*[=+\-@]|[\t\r])/, s => "'" + s).replace(/"/g, '""') + '"';
            const table = [['编号', '发生时间', '商户', '方向', '金额', '币种', '类别', '标签', '状态', '已移除', '来源编号'], ...rows.map(t => [t.id, t.occurredAt, t.merchant, t.direction, t.amountMinor === null || !(t.currency in C.DIGITS) ? t.proposedAmount : C.decimal(t.amountMinor, t.currency), t.currency, t.category, t.tags.join('、'), t.status, t.deleted ? '是' : '否', t.sourceIds.join(';')])];
            download(new Blob(['\ufeff' + table.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'shijian-bills-' + C.dayKey() + '.csv');
        } catch (error) { report(error); }
    }
    function renderMine() {
        const root = $('minePage'); root.replaceChildren(); root.append(node('h2', '', '属于自己的生活'), node('p', 'muted', '默认私密，留在你的设备里。'));
        const box = node('section', 'bill-overview'); box.append(node('p', '', S.records.length + ' 条生活记录 · ' + S.transactions.filter(t => !t.deleted).length + ' 笔交易'), node('p', 'muted', '当前保存于此浏览器，没有云同步。换设备或清除网站数据不会自动带走记录，请导出备份。'));
        box.append(button('导出完整备份 JSON', exportData, 'primary-button'), button('导出账单 CSV', exportCSV)); root.append(box);
        const label = node('label', 'check-label'), toggle = node('input'); toggle.type = 'checkbox'; toggle.checked = S.autoAI;
        toggle.addEventListener('change', async () => {
            try { await DB.put('meta', { key: 'autoAI', value: toggle.checked }); S.autoAI = toggle.checked; $('useAI').checked = S.autoAI; renderMine(); if (!S.autoAI) clearTimeout(reflectionTimer); else scheduleReflections(); }
            catch (error) { toggle.checked = S.autoAI; report(error); }
        }); label.append(toggle, node('span', '', '新记录默认使用AI整理，并在打开时梳理已结束的日／月')); root.append(label);
        root.append(node('p', 'muted', '开启时，所选文字和压缩图片会发送至配置的AI服务；原文件留在本机。每次保存也可单独关闭AI。关闭默认开关不会撤回已经发送的请求。'));
        root.append(node('p', 'muted', '完整的导入恢复、账号与数据删除设置将在“我的”模块继续完善。本版没有公开动态或自动分享。'), node('p', 'muted small', '拾间 · ' + C.VERSION));
    }
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
        $('imageInput').addEventListener('change', onImages); $('exportButton').addEventListener('click', exportData);
        document.querySelectorAll('[data-page]').forEach(e => e.addEventListener('click', () => { S.page = e.dataset.page; render(); }));
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
            S.ready = true; await refresh(); scheduleReflections();
        } catch (error) { notice('设备存储尚未就绪：' + error.message + ' 请保留已有数据，不要清除网站存储。'); }
        render(); updateSaveButton();
        document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready) void recoverImports().then(refresh).then(scheduleReflections).catch(report); });
        setInterval(() => { if (S.ready) void recoverImports().catch(() => {}); }, 30000);
    }
    Object.assign(window, { openInputPanel, closeInputPanel, saveRecord, closeModal, exportData });
    window.ShijianApp = Object.freeze({ version: C.VERSION });
    void init();
})();
