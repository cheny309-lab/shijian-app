/* 日记管理界面：不计算账本金额，不改动原始资料，不依赖第三方 UI 框架。 */
(function () {
    'use strict';
    window.ShijianJournals = { create(deps) {
        const { S, C, J, DB, node, button, field, input, modal, closeModal, refresh, report, toast, id, openRecord, showSource, runJournal, scheduleReflections, Drafts } = deps;
        const now = () => new Date().toISOString();
        const offers = new Set(); let disposeEditor = () => {};
        const visible = root => root.isConnected && document.getElementById('detailModal').classList.contains('show');
        const listRow = (root, r) => root.append(button(J.day(r) + ' · ' + J.title(r), () => openRecord(r.id), 'journal-list-row'));
        function drafts() {
            const root = modal('日记草稿');
            root.append(node('p', 'muted', '确认留下后才进入时光轴。草稿保存在此设备，退出后仍可继续。'));
            const rows = S.records.filter(r => r.journalState === 'draft' && !r.journalDeleted);
            rows.forEach(r => listRow(root, r));
            if (!rows.length) root.append(node('p', 'muted', '这里还没有草稿。'));
        }
        function trash() {
            const root = modal('最近删除');
            root.append(node('p', 'muted', '这里只移除日记展示，账单和来源资料保留。本版不自动清空，可随时回来恢复。'));
            const rows = S.records.filter(r => r.journalDeleted).sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
            rows.forEach(r => listRow(root, r));
            if (!rows.length) root.append(node('p', 'muted', '这里还没有日记。'));
        }
        function deleted(root, record) {
            root.append(node('p', 'muted', '已移入最近删除 · ' + (record.deletedAt ? new Date(record.deletedAt).toLocaleString() : '')),
                node('h3', '', J.title(record)), node('p', 'detail-text', J.body(record)));
            root.append(button('恢复这篇日记', async () => {
                try {
                    await DB.changeJournals(state => { const r = state.records.find(r => r.id === record.id); if (!r) throw Error('日记未找到。'); return { records: [J.restore(r, state.records, now())] }; });
                    await refresh(); if (visible(root)) openRecord(record.id); toast(record.journalState === 'draft' ? '已恢复到草稿。' : '已恢复日记。'); scheduleReflections();
                } catch (error) { report(error); }
            }, 'primary-button'));
            for (const sid of record.sourceIds || []) root.append(button('查看保留的来源资料', () => showSource(sid)));
        }
        function confirmRemove(record) {
            const root = modal('移入最近删除？');
            root.append(node('p', 'detail-text', '“' + J.title(record) + '”会从时光或草稿中移除，仍可恢复。关联账单和原始资料会保留。'));
            const remove = button('确认移入最近删除', async () => {
                remove.disabled = true;
                try { await DB.updateRecord(record.id, old => J.remove(old, now())); await refresh(); if (visible(root)) closeModal(); toast('已移入最近删除，可在“我的”中恢复。'); scheduleReflections(); }
                catch (error) { report(error); remove.disabled = false; }
            }, 'danger-button');
            root.append(remove, button('返回日记', () => openRecord(record.id)));
        }
        function history(record) {
            const root = modal('日记修改记录');
            root.append(node('p', 'muted', '保留初次输入和每次保存的版本。来源资料不会被日记编辑改变。'));
            root.append(node('p', 'detail-label', '初次输入'), node('p', 'detail-text', record.originalText === undefined ? record.text || '当时没有文字。' : record.originalText || '当时没有文字。'));
            for (const h of [...(record.journalHistory || [])].reverse()) {
                const box = node('details', 'reflection'); box.append(node('summary', '', (h.action || '修改正文') + ' · ' + new Date(h.at).toLocaleString()));
                for (const [label, value] of [['修改前', h.before], ['修改后', h.after]]) if (value !== undefined) {
                    box.append(node('p', 'detail-label', label), node('p', 'detail-text', typeof value === 'string' ? value : [value.title, value.displayDate, value.text, value.ai].filter(Boolean).join('\n')));
                }
                root.append(box);
            }
            root.append(button('返回日记', () => openRecord(record.id)));
        }
        function editor(root, record) {
            disposeEditor();
            if (record.journalState === 'draft') root.append(node('p', 'review-note', '日记草稿 · 还没有放入时光轴。可先编辑、保存，再确认留下。'));
            if (record.dateRange && record.dateRange[0] !== record.dateRange[1]) root.append(node('p', 'muted', '回顾 ' + record.dateRange.join(' 至 ') + ' · 默认放在最后一笔发生的日期。'));
            const title = input(J.title(record), '日记标题', root); title.maxLength = 80;
            const date = input(J.day(record), '日记展示日期', root); date.type = 'date';
            root.append(node('p', 'muted small', '调整展示日期不会更改原始创建时间或账单发生时间。'));
            const original = node('textarea', 'journal-editor journal-note'); original.value = record.text || ''; original.maxLength = 8000;
            field(root, '当时留下的话 · 可修改，初次输入仍保留', original);
            const text = node('textarea', 'journal-editor'); text.value = J.body(record); text.maxLength = 8000; text.setAttribute('aria-label', '编辑时光切片');
            root.append(node('p', 'detail-label', '属于你的文字，可以反复修改'), text);
            void Drafts.attachEditor(root,record,{title,displayDate:date,text:original,ai:text}).catch(report);
            const errorBox = node('p', 'form-error'); errorBox.setAttribute('role', 'status'); root.append(errorBox);
            const status = node('p', 'muted'); root.append(status);
            let base = { title: J.title(record), date: J.day(record), text: record.text || '', ai: J.body(record) };
            const onUpdated = async event => {
                if (!root.isConnected) { window.removeEventListener('shijian-journal-updated', onUpdated); return; }
                if (event.detail !== record.id) return;
                const latest = await DB.get('records', record.id).catch(() => null); if (!latest) return;
                status.textContent = latest.aiStatus === 'failed' ? latest.error || '这次未整理完成，可以稍后重试。' : latest.aiCandidate ? '有一份AI候选文字，重新打开可查看。' : '已整理好，文字仍可自由修改。';
                if (!record.journalEdited && !latest.journalEdited && text.value === base.ai && original.value === base.text) { text.value = J.body(latest); base.ai = text.value; }
            };
            window.addEventListener('shijian-journal-updated', onUpdated);
            disposeEditor = () => window.removeEventListener('shijian-journal-updated', onUpdated);
            let revision = record.editRevision || 0;
            const changes = () => ({ title: title.value, ai: text.value, text: original.value, displayDate: date.value });
            const update = old => {
                if ((old.editRevision || 0) !== revision) throw Error('这篇日记已在另一处修改。请先复制当前文字，再重新打开核对。');
                return J.edit(old, changes(), now());
            };
            const save = button('保存文字', async () => {
                save.disabled = true;
                try { const value = await DB.updateRecord(record.id, update); await Drafts.savedEditor(record.id); revision = value.editRevision; base = { title: title.value, date: date.value, text: original.value, ai: text.value }; await refresh(); errorBox.textContent = ''; if(visible(root)) { disposeEditor(); closeModal(); } toast('已保存你的修改。'); scheduleReflections(); }
                catch (error) { errorBox.textContent = error.message; } finally { save.disabled = false; }
            }, 'primary-button'); root.append(save);
            if (record.journalState === 'draft') {
                const publish = button('确认留下这篇日记', async () => {
                    publish.disabled = true;
                    try {
                        await DB.changeJournals(state => {
                            const old = state.records.find(r => r.id === record.id); if (!old) throw Error('草稿未找到。');
                            const edited = update(old); const latest = { ...state, records: state.records.map(r => r.id === old.id ? edited : r) };
                            return { records: J.publish(latest, [old.id], now()) };
                        });
                        await Drafts.savedEditor(record.id); await refresh(); if (visible(root)) { S.page = 'timeline'; deps.render(); openRecord(record.id); } toast('这一段，已留在时光里。'); scheduleReflections();
                    } catch (error) { errorBox.textContent = error.message; publish.disabled = false; }
                }, 'primary-button'); root.append(publish, button('查看全部草稿', drafts));
            }
            if (record.aiCandidate) {
                root.append(node('p', 'detail-label', 'AI另一个版本 · 不会覆盖你的文字'), node('p', 'detail-text', record.aiCandidate));
                root.append(button('采用这个版本', () => { text.value = record.aiCandidate; errorBox.textContent = '已填入编辑框，保存后生效。'; }));
            }
            root.append(button(record.journalState === 'draft' ? 'AI整理草稿' : '重新整理文字', async () => {
                if (text.value !== base.ai || original.value !== base.text) { errorBox.textContent = '请先保存修改，再整理文字。'; return; }
                errorBox.textContent = '正在整理，已保存的文字不会被覆盖。';
                await runJournal(record.id, true);
            }));
            root.append(button('查看最新整理', () => {
                if (text.value !== base.ai || original.value !== base.text || title.value !== base.title || date.value !== base.date) { errorBox.textContent = '请先保存当前修改，再查看最新整理。'; return; }
                openRecord(record.id);
            }));
            if (record.error) root.append(node('p', 'form-error', record.error));
            const dup = J.duplicates(record, S.records);
            if (dup.length) {
                const section = node('details', 'reflection'); section.append(node('summary', '', '可能重复的同日记录 · ' + dup.length));
                section.append(node('p', 'muted', '内容相近也可能是不同经历，拾间不会自动删除。'));
                dup.forEach(r => listRow(section, r)); root.append(section);
            }
            root.append(button('查看初次输入与修改记录', () => history(S.records.find(r => r.id === record.id) || record)), button('移入最近删除', () => confirmRemove(record), 'danger-button'));
        }
        async function choose(sourceIds) {
            try { await refresh(); } catch (error) { report(error); return; }
            const rows = J.billRows(S.transactions, S.records, sourceIds);
            const root = modal('这一段，想怎样留下？'); document.getElementById('detailModal').classList.add('choice-sheet');
            root.append(node('p', 'detail-text', rows.length ? `已找到 ${rows.length} 笔已入账记录。账本已经保存，日记由你决定。` : '这份资料暂时没有可整理为日记的已入账明细。'));
            root.append(node('p', 'muted', '折叠为一篇回顾，或挑选几笔拆成碎片。关闭这个面板也只保留账单。'));
            const existing = rows.filter(t => t.journalIds.length);
            const relatedIds = [...new Set(existing.flatMap(t => t.journalIds))];
            for (const key of relatedIds) { const r = S.records.find(r => r.id === key); if (r) root.append(button('查看已有' + (r.journalState === 'draft' ? '草稿' : '日记') + ' · ' + J.title(r), () => openRecord(key))); }
            const available = rows.filter(t => !t.journalIds.length), selected = new Set(available.filter(t => ['expense', 'income'].includes(t.direction)).map(t => t.id));
            const options = node('details', 'reflection'); options.append(node('summary', '', '选择要留下的交易（退款与转账默认不选）'));
            const counts = node('p', 'muted');
            const updateCount = () => counts.textContent = `已选 ${selected.size} 笔 · 拆分将生成 ${selected.size} 篇草稿`;
            for (const t of available) {
                const label = node('label', 'check-label'), check = node('input'); check.type = 'checkbox'; check.checked = selected.has(t.id); check.setAttribute('aria-label', '日记选取 ' + t.id);
                check.addEventListener('change', () => { if (check.checked) selected.add(t.id); else selected.delete(t.id); updateCount(); });
                label.append(check, node('span', '', t.occurredAt + ' · ' + C.merchantLabel(t) + ' · ' + ({ expense: '支出', income: '收入', refund: '退款', transfer: '转账' }[t.direction] || '记录'))); options.append(label);
            }
            root.append(options, counts); updateCount();
            const consent = node('input'); consent.type = 'checkbox'; consent.checked = S.autoAI && sourceIds.some(sid => S.records.some(r => (r.sourceIds || []).includes(sid) && r.aiAllowed));
            const label = node('label', 'check-label'); label.append(consent, node('span', '', '让AI整理草稿（仅发送所选交易的日期、商户、归类与收支方向）')); root.append(label);
            const errorBox = node('p', 'form-error'); errorBox.setAttribute('role', 'status'); root.append(errorBox);
            let busy = false;
            const make = async mode => {
                if (busy) return; busy = true;
                try {
                    const result = await DB.changeJournals(state => ({ records: J.plan(state, sourceIds, [...selected], mode, id, now(), consent.checked) }));
                    await refresh(); if (visible(root)) openRecord(result.records[0].id); toast('已存为草稿，确认后才进入时光。');
                    if (consent.checked) for (const r of result.records) void runJournal(r.id, true);
                } catch (error) { errorBox.textContent = error.message; } finally { busy = false; }
            };
            const fold = button('折叠为一篇日记', () => make('fold'), 'choice-option'); fold.append(node('small', '', '生成1篇草稿，原图可从来源展开。'));
            const split = button('拆解为多条碎片', () => make('split'), 'choice-option'); split.append(node('small', '', '只整理选中的交易，逐篇预览后留下。'));
            fold.disabled = split.disabled = !available.length;
            root.append(fold, split, button('只存入生活账本', () => { closeModal(); toast('已留在账本，时光轴保持原样。'); }, 'choice-option'));
        }
        function offer(sourceId) { return; /* 主动选择才生成日记。 */
            if (!offers.has(sourceId)) return;
            offers.delete(sourceId);
            if (document.hidden || S.page !== 'timeline' || document.getElementById('detailModal').classList.contains('show') || document.getElementById('inputPanel').classList.contains('show')) return;
            const rows = J.billRows(S.transactions, S.records, [sourceId]);
            if (rows.filter(t => !t.journalIds.length).length > 1) void choose([sourceId]);
        }
        return { editor, deleted, drafts, trash, choose, offer, markOffer: sourceId => offers.add(sourceId) };
    } };
})();
