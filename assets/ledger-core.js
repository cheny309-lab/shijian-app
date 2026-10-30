/* 纯业务模块：浏览器与 Node 测试共用。金额以整数最小货币单位保存。 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.LedgerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const VERSION = '2026.10.30-usability-v0.5.2';
    const CATEGORIES = ['餐饮', '出行', '居家', '购物', '健康', '学习', '休闲', '生活服务', '其他'];
    const DIGITS = { CNY: 2, USD: 2, HKD: 2, EUR: 2, GBP: 2, SGD: 2, AUD: 2, CAD: 2, JPY: 0, TWD: 2, KRW: 0 };
    const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
    const key = value => clean(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    function safeAlias(alias, merchant) {
        const text = clean(alias, 100), original = key(merchant), candidate = key(text).replace(/[\p{P}\p{S}]/gu, '');
        if (!candidate) return '';
        let at = 0;
        for (const char of candidate) { const next = original.indexOf(char, at); if (next < 0) return ''; at = next + char.length; }
        return text;
    }
    function merchantLabel(t) {
        if (t.displayName) return clean(t.displayName, 100);
        return clean(t.merchant, 100).replace(/^(?:扫二维码付款|扫码付款|二维码收款|扫码支付|付款给)[\s:：\-—]*(?:给)?/, '').trim() || clean(t.merchant, 100) || '一笔记录';
    }
    function bookOf(t) { return t.bookId || 'daily'; }
    function inBook(rows, book) { return !book || book === 'all' ? rows : rows.filter(t => bookOf(t) === book); }
    function documentKind(data) {
        if ((data.transactions || []).length || (data.totals || []).length) return 'bill';
        return ['bill', 'life'].includes(data.documentKind) ? data.documentKind : 'uncertain';
    }
    function routeRecord(record, kind) {
        // 历史记录保持原展示；只有本版新增记录自动分流，用户选择永远优先。
        if (!record.routingVersion) return record;
        if (record.placementUser) return { ...record, receipt: kind === 'bill' };
        let placement = record.placement;
        if (record.intent === 'bill') placement = 'bills';
        else if (record.intent === 'journal') placement = 'journal';
        else if (kind === 'bill') placement = 'bills';
        else if (!record.image) placement = 'journal';
        else placement = kind === 'life' ? 'journal' : 'pending';
        return { ...record, placement, receipt: kind === 'bill', aiStatus: placement === 'journal' ? record.aiStatus : 'idle' };
    }
    function onTimeline(record) { return !record.journalDeleted && record.journalState !== 'draft' && (!record.placement || record.placement === 'journal'); }
    function money(value, currency = 'CNY') {
        if (!(currency in DIGITS)) return null;
        const s = String(value == null ? '' : value).trim();
        if (!/^\d{1,12}(\.\d{1,3})?$/.test(s)) return null;
        const [whole, fraction = ''] = s.split('.');
        const digits = DIGITS[currency];
        if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) return null;
        const n = Number(whole) * 10 ** digits + Number((fraction.slice(0, digits) + '0'.repeat(digits)).slice(0, digits) || 0);
        return Number.isSafeInteger(n) ? n : null;
    }
    function decimal(minor, currency) { return (minor / 10 ** (DIGITS[currency] || 0)).toFixed(DIGITS[currency] || 0); }
    function date(value) {
        const s = clean(value, 19).replace('T', ' ');
        const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
        if (!m) return null;
        const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
        const test = new Date(+y, +mo - 1, +d, +h, +mi, +se);
        if (+y < 1900 || +y > 2200 || test.getFullYear() !== +y || test.getMonth() !== +mo - 1 || test.getDate() !== +d || +h > 23 || +mi > 59 || +se > 59) return null;
        return { value: s, day: s.slice(0, 10), precision: m[4] ? 'time' : 'day', timestamp: test.getTime() };
    }
    function dayKey(value = new Date()) {
        const d = new Date(value);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function normalize(raw, sourceId, index, now = Date.now()) {
        raw = raw && typeof raw === 'object' ? raw : {};
        const currency = clean(raw.currency, 8).toUpperCase();
        const occurred = date(raw.occurredAt);
        const amountMinor = money(raw.amount, currency);
        const direction = ['expense', 'income', 'refund', 'transfer'].includes(raw.direction) ? raw.direction : 'unknown';
        const paymentState = ['paid', 'pending', 'closed', 'unknown'].includes(raw.paymentState) ? raw.paymentState : 'unknown';
        const evidence = Object.fromEntries(['amount', 'date', 'merchant', 'direction', 'transactionId', 'provider'].map(field => [field, clean(raw.evidence && raw.evidence[field], 300)]));
        const verified = raw.verified || {};
        const reasons = [];
        if (amountMinor === null) reasons.push('金额或币种需要确认');
        if (!occurred) reasons.push('交易日期不完整');
        else if (occurred.timestamp > now + 300000) reasons.push('交易时间晚于当前时间');
        if (direction === 'unknown') reasons.push('收支方向需要确认');
        if (paymentState !== 'paid') reasons.push(paymentState === 'closed' ? '来源显示交易关闭，暂不计入' : '尚不能确认交易已完成');
        if (!evidence.amount || !evidence.date || !evidence.direction) reasons.push('关键字段缺少来源摘录');
        const evidenceAmounts = evidence.amount.replace(/[,，]/g, '').match(/\d+(?:\.\d+)?/g) || [];
        if (amountMinor !== null && !evidenceAmounts.some(value => money(value, currency) === amountMinor)) reasons.push('金额与来源摘录不一致');
        if (occurred) {
            const ds = evidence.date.replace(/年|\//g, '-').replace(/月/g, '-').replace(/日/g, '');
            const dm = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(ds);
            let evidenceDay = dm && `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
            // 微信等月度流水把年份放在页头，行内只显示月日；仅组合明确且同月的两段来源。
            if (!evidenceDay) {
                const ym = /(\d{4})年(\d{1,2})月/.exec(evidence.date);
                const md = /(?:^|[；;\s])(\d{1,2})月(\d{1,2})日/.exec(evidence.date);
                if (ym && md && +ym[2] === +md[1]) evidenceDay = `${ym[1]}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
            }
            const times = [...evidence.date.matchAll(/(\d{1,2}):(\d{2})/g)].map(m => m[1].padStart(2, '0') + ':' + m[2]);
            if (evidenceDay !== occurred.day || (occurred.precision === 'time' && !times.includes(occurred.value.slice(11, 16)))) reasons.push('日期与来源摘录不一致或不完整');
        }
        if (!['amount', 'date', 'direction', 'paymentState'].every(field => verified[field] === true)) reasons.push('AI复核尚未通过关键字段');
        return {
            id: `${sourceId}:row:${index}`, sourceIds: [sourceId], sourceRow: index,
            occurredAt: occurred ? occurred.value : clean(raw.occurredAt, 40), precision: occurred ? occurred.precision : 'unknown',
            amountMinor, proposedAmount: clean(String(raw.amount == null ? '' : raw.amount), 30), currency,
            direction, paymentState, merchant: clean(raw.merchant, 100), category: CATEGORIES.includes(raw.category) ? raw.category : '其他',
            categoryTentative: true, tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.map(t => clean(t, 20)).filter(Boolean))].slice(0, 5) : [],
            subcategory: clean(raw.subcategory, 30), displayName: safeAlias(raw.displayName, raw.merchant), bookId: 'daily',
            provider: clean(raw.provider, 40), transactionId: clean(raw.transactionId, 120), identityVerified: verified.identity === true && !!clean(raw.transactionId, 120) && evidence.transactionId.includes(clean(raw.transactionId, 120)) && !!key(raw.provider) && key(evidence.provider).includes(key(raw.provider)), originalTransactionId: clean(raw.originalTransactionId, 120), refundOf: null, evidence,
            status: reasons.length ? 'review' : 'confirmed', confirmation: reasons.length ? '' : 'system', reasons,
            proposal: clean(raw.proposal, 300), duplicateOf: null, deleted: false, history: [], createdAt: new Date(now).toISOString()
        };
    }
    function sameReceipt(a, b) {
        return a.identityVerified && b.identityVerified && a.transactionId && b.transactionId && a.provider && b.provider &&
            a.transactionId === b.transactionId && key(a.provider) === key(b.provider) && a.direction === b.direction;
    }
    function possibleDuplicate(a, b) {
        if (a.amountMinor === null || b.amountMinor === null || a.amountMinor !== b.amountMinor || a.currency !== b.currency || a.direction !== b.direction) return false;
        const da = date(a.occurredAt), db = date(b.occurredAt);
        if (!da || !db || da.day !== db.day) return false;
        if((a.entryMethod==='text'||b.entryMethod==='text')&&a.category===b.category&&a.category!=='其他')return true;
        if (!key(a.merchant) || key(a.merchant) !== key(b.merchant)) return false;
        return da.precision === 'day' || db.precision === 'day' || Math.abs(da.timestamp - db.timestamp) <= 120000;
    }
    function ingest(existing, candidates) {
        const all = existing.map(t => ({ ...t, sourceIds: [...t.sourceIds], history: [...(t.history || [])] }));
        let linked = 0, added = 0;
        for (const candidate of candidates) {
            const input = { ...candidate, sourceIds: [...candidate.sourceIds], history: [...(candidate.history || [])], reasons: [...(candidate.reasons || [])] };
            if (all.some(t => t.id === input.id)) continue;
            const exact = all.find(t => sameReceipt(t, input));
            if (exact && exact.amountMinor === input.amountMinor && exact.currency === input.currency && exact.occurredAt === input.occurredAt) {
                exact.sourceIds = [...new Set([...exact.sourceIds, ...input.sourceIds])];
                exact.history.push({ at: new Date().toISOString(), action: '关联同交易号来源', sourceIds: input.sourceIds });
                linked++; continue;
            }
            const duplicate = exact || all.find(t => possibleDuplicate(t, input));
            if (duplicate) {
                input.status = 'review'; input.confirmation = ''; input.duplicateOf = duplicate.id;
                input.reasons = [...input.reasons, exact ? '同一交易号的字段存在差异，建议核对后合并' : '与已有记录相似，建议核对是否为同一笔'];
            }
            all.push(input); added++;
        }
        for (const t of all.filter(t => t.direction === 'refund' && !t.refundOf && t.originalTransactionId && t.provider)) {
            const original = all.filter(o => !o.deleted && o.direction === 'expense' && o.transactionId === t.originalTransactionId && key(o.provider) === key(t.provider) && o.currency === t.currency);
            if (original.length === 1) { t.refundOf = original[0].id; if (!t.bookManuallySet) t.bookId = bookOf(original[0]); }
        }
        return { transactions: all, linked, added };
    }
    function summary(transactions, month) {
        const currencies = {};
        const reviews = transactions.filter(t => !t.deleted && t.status !== 'confirmed' && (!date(t.occurredAt) || t.occurredAt.startsWith(month))).length;
        let latest = '';
        for (const t of transactions) {
            if (t.deleted || t.status !== 'confirmed' || !date(t.occurredAt) || !t.occurredAt.startsWith(month) || !Number.isSafeInteger(t.amountMinor) || !(t.currency in DIGITS)) continue;
            if (t.occurredAt > latest) latest = t.occurredAt;
            const group = currencies[t.currency] ||= { income: 0, expense: 0, refund: 0, net: 0, count: 0, categories: {} };
            group.count++;
            if (['income', 'expense', 'refund'].includes(t.direction)) {
                group[t.direction] += t.amountMinor;
                if (!Number.isSafeInteger(group[t.direction])) throw Error('累计金额过大，暂不能可靠计算。');
            }
            if (t.direction === 'expense') group.categories[t.category] = (group.categories[t.category] || 0) + t.amountMinor;
            group.net = group.expense - group.refund;
        }
        return { currencies, latest, reviews };
    }
    function checkTotals(candidates, totals) {
        const warnings = [];
        for (const total of (Array.isArray(totals) ? totals : [])) {
            if (total.scope !== 'visible' || !['expense', 'income', 'refund'].includes(total.direction)) continue;
            const expected = money(total.amount, total.currency);
            if (expected === null) continue;
            const rows = candidates.filter(t => t.currency === total.currency && t.direction === total.direction && t.amountMinor !== null);
            const got = rows.reduce((n, t) => n + t.amountMinor, 0);
            if (got !== expected) {
                warnings.push('截图可见明细与合计不一致，相关交易暂不入账');
                rows.forEach(t => { t.status = 'review'; t.confirmation = ''; t.reasons.push('可见明细与来源合计不一致'); });
            }
        }
        return warnings;
    }
    function edit(transaction, changes, action = '用户修改') {
        const next = { ...transaction, ...changes, updatedAt: new Date().toISOString() };
        next.history = [...(transaction.history || []), { at: next.updatedAt, action, before: Object.fromEntries(Object.keys(changes).map(k => [k, transaction[k]])), after: changes }];
        return next;
    }
    function digest(value) {
        const s = JSON.stringify(value); let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(16);
    }
    // 每次仅安排少量历史期间，未完成期间下次打开继续；同一修订失败不自动反复收费。
    function reflectionJobs(transactions, records, reflections, today = dayKey(), limit = 6) {
        const periods = new Map();
        for (const t of transactions.filter(t => !t.deleted && t.aiAllowed !== false && t.status === 'confirmed' && date(t.occurredAt))) {
            for (const period of [t.occurredAt.slice(0, 10), t.occurredAt.slice(0, 7)]) {
                if (period.length === 10 ? period >= today : period >= today.slice(0, 7)) continue;
                if (!periods.has(period)) periods.set(period, []);
                periods.get(period).push(t);
            }
        }
        // 普通日记也可形成回看；空白日期绝不补写。
        for (const r of records) {
            const day = date(r.displayDate) ? r.displayDate.slice(0, 10) : dayKey(r.time);
            for (const period of [day, day.slice(0, 7)]) {
                if (period.length === 10 ? period >= today : period >= today.slice(0, 7)) continue;
                if (!periods.has(period)) periods.set(period, []);
            }
        }
        const jobs = [];
        for (const [id, rows] of [...periods].sort(([a], [b]) => a.length - b.length || b.localeCompare(a))) {
            const totals = summary(rows, id.slice(0, 7)).currencies;
            const moneyText = Object.entries(totals).map(([currency, t]) => ({ currency, income: decimal(t.income, currency), expense: decimal(t.expense, currency), refund: decimal(t.refund, currency) }));
            const periodRecords = records.filter(r => (date(r.displayDate) ? r.displayDate.slice(0, 10) : dayKey(r.time)).startsWith(id));
            const notes = periodRecords.map(r => (r.journalEdited ? r.ai : r.text) || '').filter(Boolean).slice(0, 15).map(s => s.slice(0, 160));
            const facts = { id, totals: moneyText, count: rows.length, recordCount: periodRecords.length, imageRecordCount: periodRecords.filter(r => !!r.image).length, merchants: [...new Set(rows.map(t => merchantLabel(t)).filter(Boolean))].slice(0, 12), notes };
            const revision = digest({ style: 'v012-natural', facts, rows: rows.map(t => [t.id, t.amountMinor, t.occurredAt, t.category, t.tags]).sort() });
            const old = reflections.find(r => r.id === id);
            if (!old || (old.revision !== revision && old.attemptedRevision !== revision)) jobs.push({ ...facts, revision });
        }
        return jobs.slice(0, limit);
    }
    return { VERSION, CATEGORIES, DIGITS, clean, money, decimal, date, dayKey, normalize, sameReceipt, possibleDuplicate, ingest, summary, checkTotals, edit, digest, reflectionJobs, merchantLabel, bookOf, inBook, documentKind, routeRecord, onTimeline };
});
