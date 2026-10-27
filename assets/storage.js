/* IndexedDB 兼容升级：沿用稳定版数据库，旧记录与旧 localStorage 均保留。 */
(function () {
    'use strict';
    let db;
    const STORES = ['records', 'meta', 'sources', 'transactions', 'imports', 'reflections'];
    function request(storeName, mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            let req;
            try { req = operation(tx.objectStore(storeName)); }
            catch (error) { tx.abort(); reject(error); return; }
            tx.oncomplete = () => resolve(req && req.result);
            tx.onerror = () => reject(tx.error || new Error('设备保存失败'));
            tx.onabort = () => reject(tx.error || new Error('设备保存中止'));
        });
    }
        function legacyRecords(items) {
            const result = [];
            let current = null;
            const finish = () => { if (current) result.push(current); current = null; };
            items.forEach((item, index) => {
                if (!item || typeof item.content !== 'string') return;
                const time = Number.isFinite(Date.parse(item.time)) ? new Date(item.time).toISOString() : new Date(0).toISOString();
                const fresh = () => ({ id: 'legacy-' + index, time, text: '', image: null, ai: '', aiStatus: 'idle', error: '', legacy: true });
                if (item.role === 'ai') {
                    if (!current) current = fresh();
                    current.ai = item.content;
                    current.aiStatus = 'done';
                    finish();
                } else {
                    const field = item.type === 'image' ? 'image' : 'text';
                    if (!current || current[field] || Math.abs(Date.parse(time) - Date.parse(current.time)) > 60000) {
                        finish(); current = fresh();
                    }
                    current[field] = item.content;
                }
            });
            finish();
            return result;
        }
        async function migrateLegacy() {
            let raw;
            try { raw = localStorage.getItem('shijian_history'); }
            catch (_) { return '旧版存储暂不可读，旧数据未删除。'; }
            if (!raw) return '';
            let legacy;
            try { legacy = JSON.parse(raw); if (!Array.isArray(legacy)) throw new Error(); }
            catch (_) { return '旧记录格式异常，已保留原数据；请先导出备份。'; }
            const records = legacyRecords(legacy);
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['records', 'meta'], 'readwrite');
                const meta = tx.objectStore('meta');
                const check = meta.get('legacy-migrated');
                check.onsuccess = () => {
                    if (check.result) return;
                    records.forEach(record => tx.objectStore('records').put(record));
                    meta.put({ key: 'legacy-migrated', count: records.length });
                };
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('旧数据迁移未完成'));
            });
            // 原 localStorage 留存，供回退与原始备份；新记录不再写入容量很小的 localStorage。
            return '';
        }

    async function init() {
        db = await new Promise((resolve, reject) => {
            const open = indexedDB.open('shijian_records_v2', 2);
            open.onupgradeneeded = () => STORES.forEach(name => {
                if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : 'id' });
            });
            let blocked = false;
            open.onsuccess = () => {
                if (blocked) { open.result.close(); return; }
                open.result.onversionchange = () => { open.result.close(); window.dispatchEvent(new Event('shijian-storage-closed')); };
                resolve(open.result);
            };
            open.onerror = () => reject(open.error);
            open.onblocked = () => { blocked = true; reject(new Error('请关闭其他拾间页面后刷新。')); };
        });
        const warning = await migrateLegacy();
        return { warning, data: await snapshot(false) };
    }
    const getAll = name => request(name, 'readonly', store => store.getAll());
    const get = (name, id) => request(name, 'readonly', store => store.get(id));
    const put = (name, value) => request(name, 'readwrite', store => store.put(value));
    async function snapshot(includeOriginals = true) {
        const result = {};
        // 单个只读事务读取备份，避免导出过程中不同表处于不同修订。
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORES, 'readonly');
            STORES.forEach(name => {
                if (name === 'sources' && !includeOriginals) {
                    result.sources = [];
                    const req = tx.objectStore(name).openCursor();
                    req.onsuccess = () => { const cursor = req.result; if (!cursor) return; const value = cursor.value; delete value.original; result.sources.push(value); cursor.continue(); };
                } else { const req = tx.objectStore(name).getAll(); req.onsuccess = () => { result[name] = req.result; }; }
            });
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        return result;
    }
    // 一个批次的原始记录和原始文件在同一事务中保存，成功前绝不清空输入。
    function saveBatch(records, sources) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['records', 'sources'], 'readwrite');
            records.forEach(record => tx.objectStore('records').put(record));
            sources.forEach(source => {
                const store = tx.objectStore('sources');
                const req = store.get(source.id);
                req.onsuccess = () => {
                    const old = req.result;
                    store.put(old ? { ...old, recordIds: [...new Set([...(old.recordIds || []), ...source.recordIds])] } : source);
                };
            });
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('保存中止'));
        });
    }
    // 账本读-改-写放在一个事务中；多标签页并发也不会重复累计或覆盖其他人的核对。
    function changeLedger(transform) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['transactions', 'imports', 'meta'], 'readwrite');
            const state = {}; let pending = 3, result;
            for (const name of ['transactions', 'imports', 'meta']) {
                const req = tx.objectStore(name).getAll();
                req.onsuccess = () => {
                    state[name] = req.result;
                    if (--pending) return;
                    try {
                        result = transform(state);
                        for (const table of ['transactions', 'imports', 'meta']) (result[table] || []).forEach(value => tx.objectStore(table).put(value));
                    } catch (error) { reject(error); tx.abort(); }
                };
            }
            tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('账本更新中止'));
        });
    }
    // 记录修改同样按最新版本合并，避免迟到的 AI 回复覆盖用户文字。
    function updateRecord(id, transform) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('records', 'readwrite'); let value;
            const req = tx.objectStore('records').get(id);
            req.onsuccess = () => {
                if (!req.result) return;
                try { value = transform(req.result); tx.objectStore('records').put(value); }
                catch (error) { reject(error); tx.abort(); }
            };
            tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
    }
    // 日记草稿、发布、恢复按同一快照校验；并发标签页也不能重复发布同一笔交易。
    function changeJournals(transform) {
        return new Promise((resolve, reject) => {
            const names = ['records', 'sources', 'transactions'], tx = db.transaction(names, 'readwrite');
            const state = {}; let pending = names.length, result;
            names.forEach(name => {
                const req = tx.objectStore(name).getAll();
                req.onsuccess = () => {
                    state[name] = req.result;
                    if (--pending) return;
                    try {
                        result = transform(state);
                        (result.records || []).forEach(r => tx.objectStore('records').put(r));
                        for (const source of state.sources) {
                            const related = (result.records || []).filter(r => (r.sourceIds || []).includes(source.id)).map(r => r.id);
                            if (related.length) tx.objectStore('sources').put({ ...source, recordIds: [...new Set([...(source.recordIds || []), ...related])] });
                        }
                    } catch (error) { reject(error); tx.abort(); }
                };
            });
            tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('日记保存中止'));
        });
    }
    window.ShijianStorage = { init, getAll, get, put, snapshot, saveBatch, changeLedger, updateRecord, changeJournals };
})();
