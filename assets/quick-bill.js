/* 短句单笔：严格匹配明确的生活消费，不将价格、计划或叙事猜成交易。 */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./ledger-core'):root.LedgerCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.ShijianQuickBill=api;})(typeof globalThis!=='undefined'?globalThis:this,function(C){
    'use strict';
    const PURPOSES={早餐:'餐饮',早饭:'餐饮',午餐:'餐饮',午饭:'餐饮',晚餐:'餐饮',晚饭:'餐饮',夜宵:'餐饮',烧烤:'餐饮',咖啡:'餐饮',奶茶:'餐饮',买菜:'居家',地铁:'出行',公交:'出行',打车:'出行',停车费:'出行',停车:'出行',充电宝:'生活服务',理发:'生活服务',买书:'学习',电影:'休闲',购物:'购物',买药:'健康'};
    const KEYS=Object.keys(PURPOSES).sort((a,b)=>b.length-a.length).join('|');
    function parse(text,now=new Date(),defaultCurrency='CNY'){
        if(typeof text!=='string'||text.length>80)return null;
        const original=text.trim(),s=original.replace(/[，,。！!；;]$/,'').trim();
        // 整句只能是日期、用途、支付方式、消费动作与一个金额；叙事及未知币种交原流程。
        const re=new RegExp('^(今天|今日|昨天|昨日|前天)?\\s*('+KEYS+')\\s*(现金|微信|支付宝)?\\s*(?:花了|花|付了|支付了|支付|付款|支出)?\\s*([¥￥])?\\s*(\\d{1,9}(?:\\.\\d{1,2})?)\\s*(元|块钱|块|人民币)?\\s*(现金|微信|支付宝)?$');
        const m=re.exec(s);if(!m)return null;
        if(m[3]&&m[7]&&m[3]!==m[7])return null;
        const currency=m[4]||m[6]?'CNY':defaultCurrency;if(!(currency in C.DIGITS))return null;
        const minor=C.money(m[5],currency);if(minor===null||minor<=0)return null;
        const d=new Date(now);if(!Number.isFinite(d.getTime()))return null;
        const offset=/昨天|昨日/.test(m[1]||'')?1:m[1]==='前天'?2:0;d.setDate(d.getDate()-offset);
        return {original,merchant:m[2],category:PURPOSES[m[2]],amountMinor:minor,currency,occurredAt:C.dayKey(d),paymentMethod:m[3]||m[7]||'',needsConfirmation:false,dateDefaulted:!m[1]};
    }
    function transaction(p,sourceId,bookId,now=new Date()){
        if(!p||!C.date(p.occurredAt)||!Number.isSafeInteger(p.amountMinor)||p.amountMinor<=0)throw Error('请再核对这笔记录。');
        return {id:sourceId+':row:0',sourceIds:[sourceId],sourceRow:0,occurredAt:p.occurredAt,precision:'day',amountMinor:p.amountMinor,proposedAmount:C.decimal(p.amountMinor,p.currency),currency:p.currency,direction:'expense',paymentState:'paid',merchant:p.merchant,category:p.category,categoryTentative:true,tags:[],subcategory:'',displayName:'',bookId:bookId||'daily',provider:'',paymentMethod:p.paymentMethod,transactionId:'',identityVerified:false,originalTransactionId:'',refundOf:null,evidence:{amount:p.original,date:p.occurredAt,direction:'用户主动记录消费',merchant:p.merchant,provider:'',transactionId:''},status:'confirmed',confirmation:'declaration',reasons:[],proposal:'',duplicateOf:null,deleted:false,history:[{at:new Date(now).toISOString(),action:'依据用户短句记录；日期按输入预览；未经支付平台验证'}],createdAt:new Date(now).toISOString(),entryMethod:'text',dateDefaulted:p.dateDefaulted};
    }
    return {parse,transaction};
});
