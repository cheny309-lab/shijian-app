/* 短句单笔：严格匹配明确的生活消费，不将价格、计划或叙事猜成交易。 */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./ledger-core'):root.LedgerCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.ShijianQuickBill=api;})(typeof globalThis!=='undefined'?globalThis:this,function(C){
    'use strict';
    const PURPOSES={吃饭:'餐饮',餐费:'餐饮',饭钱:'餐饮',车费:'出行',水电费:'居家',房租:'居家',早餐:'餐饮',早饭:'餐饮',午餐:'餐饮',午饭:'餐饮',晚餐:'餐饮',晚饭:'餐饮',夜宵:'餐饮',烧烤:'餐饮',咖啡:'餐饮',奶茶:'餐饮',买菜:'居家',地铁:'出行',公交:'出行',打车:'出行',停车费:'出行',停车:'出行',充电宝:'生活服务',理发:'生活服务',买书:'学习',电影:'休闲',购物:'购物',买药:'健康'};
    const KEYS=Object.keys(PURPOSES).sort((a,b)=>b.length-a.length).join('|');
    function parse(text,now=new Date(),defaultCurrency='CNY'){
        if(typeof text!=='string'||text.length>80)return null;
        const original=text.trim();let s=original.normalize('NFKC').replace(/[，,。！!；;]$/,'').trim();
        // 整句只能是日期、用途、支付方式、消费动作与一个金额；叙事及未知币种交原流程。
        const re=new RegExp('^(今天|今日|昨天|昨日|前天)?\\s*('+KEYS+')\\s*(现金|微信|支付宝)?\\s*(?:花了|花|付了|支付了|支付|付款|支出)?\\s*([¥￥])?\\s*(\\d{1,9}(?:\\.\\d{1,2})?)\\s*(元|块钱|块|人民币)?\\s*(现金|微信|支付宝)?$');
        let m=re.exec(s),direction='expense';
        if(!m){
            if(/(?:没|未|不)(?:有|曾|花|付|支出|支付|消费|收到|收入|退款|买)|明天|后天|打算|准备|计划|预算|报价|售价|价格|人均|大概|可能|没花|没有|未付|待付|不花|不付|不买|取消|失败|原价|打折前|如果|假如|预计|美元|港币|欧元|日元|新元|约|这本|这家/.test(s))return null;
            const suffix='\\s*([¥￥])?\\s*(\\d{1,9}(?:\\.\\d{1,2})?)\\s*(元|块钱|块|人民币)?$',date='(今天|今日|昨天|昨日|前天)?\\s*',action='(花了|付了|支付了|支出|收入|收到|退款)';
            let a=new RegExp('^'+date+'([^0-9¥￥$，,。；;！!?？]{1,35}?)\\s*'+action+suffix).exec(s),merchant;
            if(a){merchant=a[2].trim().replace(/^买了/,'');direction=/收入|收到/.test(a[3])?'income':a[3]==='退款'?'refund':'expense';m=[s,a[1],merchant,'',a[4],a[5],a[6],''];}
            else {a=new RegExp('^'+date+action+'\\s*([^0-9¥￥$，,。；;！!?？]{1,35}?)'+suffix).exec(s);if(a){merchant=a[3].trim();direction=/收入|收到/.test(a[2])?'income':a[2]==='退款'?'refund':'expense';m=[s,a[1],merchant,'',a[4],a[5],a[6],''];}}
            if(!m||!merchant)return null;
        }
        if(m[3]&&m[7]&&m[3]!==m[7])return null;
        const currency=m[4]||m[6]?'CNY':defaultCurrency;if(!(currency in C.DIGITS))return null;
        const minor=C.money(m[5],currency);if(minor===null||minor<=0)return null;
        const d=new Date(now);if(!Number.isFinite(d.getTime()))return null;
        const offset=/昨天|昨日/.test(m[1]||'')?1:m[1]==='前天'?2:0;d.setDate(d.getDate()-offset);
        return {original,merchant:m[2],category:PURPOSES[m[2]]||'其他',direction,amountMinor:minor,currency,occurredAt:C.dayKey(d),paymentMethod:m[3]||m[7]||'',needsConfirmation:false,dateDefaulted:!m[1]};
    }
    function transaction(p,sourceId,bookId,now=new Date()){
        if(!p||!C.date(p.occurredAt)||!Number.isSafeInteger(p.amountMinor)||p.amountMinor<=0)throw Error('请再核对这笔记录。');
        return {id:sourceId+':row:0',sourceIds:[sourceId],sourceRow:0,occurredAt:p.occurredAt,precision:'day',amountMinor:p.amountMinor,proposedAmount:C.decimal(p.amountMinor,p.currency),currency:p.currency,direction:p.direction||'expense',paymentState:'paid',merchant:p.merchant,category:p.category,categoryTentative:true,tags:[],subcategory:'',displayName:'',bookId:bookId||'daily',provider:'',paymentMethod:p.paymentMethod,transactionId:'',identityVerified:false,originalTransactionId:'',refundOf:null,evidence:{amount:p.original,date:p.occurredAt,direction:'用户主动记录'+({income:'收入',refund:'退款',transfer:'本人转账'}[p.direction]||'消费'),merchant:p.merchant,provider:'',transactionId:''},status:'confirmed',confirmation:'declaration',reasons:[],proposal:'',duplicateOf:null,deleted:false,history:[{at:new Date(now).toISOString(),action:'依据用户短句记录；日期按输入预览；未经支付平台验证'}],createdAt:new Date(now).toISOString(),entryMethod:'text',dateDefaulted:p.dateDefaulted};
    }
    function manual(v){const merchant=C.clean(v.purpose,60),currency=v.currency,date=v.date,direction=v.direction;
        if(!merchant)throw Error('写下这笔是什么，就可以了。');if(!(currency in C.DIGITS))throw Error('选一个币种。');if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!C.date(date))throw Error('选一个有效日期。');if(!['expense','income','refund','transfer'].includes(direction))throw Error('选一下收支方向。');
        const amountMinor=C.money(String(v.amount||'').normalize('NFKC').trim(),currency);if(amountMinor===null||amountMinor<=0)throw Error('填一个大于零的有效金额，输入仍保留。');
        const original=merchant+' · '+({expense:'支出',income:'收入',refund:'退款',transfer:'本人账户间转账'}[direction])+' '+currency+' '+C.decimal(amountMinor,currency)+' · '+date+(v.note?'；'+C.clean(v.note,2000):'');
        return {original,merchant,category:PURPOSES[merchant]||'其他',direction,amountMinor,currency,occurredAt:date,paymentMethod:'',dateDefaulted:false,needsConfirmation:false};
    }
    return {parse,transaction,manual};
});
