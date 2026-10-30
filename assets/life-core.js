/* 消费内容整理：原始凭据不变；分类可缺省；个人修改与同用途偏好优先。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./ledger-core'),require('./display-core'));else root.ShijianLife=factory(root.LedgerCore,root.ShijianDisplay);})(typeof globalThis!=='undefined'?globalThis:this,function(C,D){
 'use strict';
 const text=(s,n=80)=>C.clean(s,n).normalize('NFKC').replace(/\s+/g,' '),key=s=>text(s).replace(/\s+/g,'').toLowerCase();
 const major=c=>({'出行':'交通','生活服务':'生活','其他':'未归类'}[c]||c||'未归类');
 const category=m=>({'交通':'出行','生活':'生活服务','未归类':'其他'}[m]|| (C.CATEGORIES.includes(m)?m:'其他'));
 const TYPES=[[/地铁|轨道交通/,'出行','地铁'],[/公交|公共汽车/,'出行','公交'],[/打车|网约车|滴滴出行/,'出行','打车'],[/充电宝|共享充电|怪兽充电|倍电/,'生活服务','充电宝'],[/外卖|饿了么/,'餐饮','外卖'],[/午饭|午餐/,'餐饮','午饭'],[/晚饭|晚餐/,'餐饮','晚饭'],[/早餐|早饭/,'餐饮','早餐'],[/咖啡|星巴克|瑞幸/,'餐饮','咖啡'],[/良品铺子|零食/,'餐饮','零食'],[/WPS|软件会员/i,'生活服务','软件会员'],[/大模型.*充值|API.*充值|AI工具/i,'学习','AI工具'],[/话费|通信费|宽带费/,'生活服务','通信'],[/芒果TV|腾讯视频|爱奇艺|优酷|视频会员/i,'休闲','视频会员'],[/药店|药房|医药费/,'健康','医药'],[/学费|课程费/,'学习','课程'],[/物业费/,'居家','物业'],[/水费|电费|水电费/,'居家','水电'],[/深圳通/,'出行','']];
 const MINOR_CATEGORY={'地铁':'出行','公交':'出行','打车':'出行','充电宝':'生活服务','外卖':'餐饮','午饭':'餐饮','晚饭':'餐饮','早餐':'餐饮','咖啡':'餐饮','零食':'餐饮','下午茶':'餐饮','软件会员':'生活服务','AI工具':'学习','通信':'生活服务','视频会员':'休闲','医药':'健康','课程':'学习','物业':'居家','水电':'居家'};
 const EQUIVALENTS={'轨道交通':'地铁','地铁乘车':'地铁','网约车':'打车','出租车':'打车','共享充电宝':'充电宝','移动电源租赁':'充电宝','外卖配送':'外卖'};
 const normalizeMinor=s=>EQUIVALENTS[text(s,16)]||text(s,16);
 function basis(t){return [t.merchant,t.evidence?.merchant,t.evidence?.detail,t.entryMethod==='text'?t.evidence?.amount:''].filter(Boolean).join('；');}
 function infer(t){const b=basis(t),match=TYPES.find(([re])=>re.test(b));let c=match?match[1]:C.CATEGORIES.includes(t.category)?t.category:'其他',minor=match?match[2]:'';
  if(t.categoryTentative===false&&C.CATEGORIES.includes(t.category))c=t.category;
  const l=t.life||{},e=text(l.sceneEvidence,200);let scene='';
  // 模型只提供有本笔摘录支持的地点/场景；没有依据的补全不入展示。
  if(text(l.scene,24)&&e.includes(text(l.scene,24))&&basis({...t,life:{}}).includes(e))scene=text(l.scene,24);
  const me=text(l.minorEvidence,200),m=normalizeMinor(l.minor||t.subcategory);
  if(!minor&&m&&me&&basis({...t,life:{}}).includes(me))minor=m;
  if(!scene&&minor==='地铁'){
   const stations=[...text(t.merchant,200).matchAll(/(?:地铁-|\d{2}:\d{2}(?::\d{2})?-)([\u4e00-\u9fff]{2,10})(?=-|$)/g)].map(m=>m[1]);
   scene=[...new Set(stations)].slice(0,2).join('／');
  }
  if(t.categoryTentative!==false&&MINOR_CATEGORY[minor])c=MINOR_CATEGORY[minor];
  return {category:c,minor,scene};
 }
 function parts(t){if(t.lifeUser&&t.life){return {major:major(t.life.category||t.category),minor:text(t.life.minor,16),scene:text(t.life.scene,24),name:t.correctedMerchant?D.merchant(t):''};}
  const v=infer(t),name=D.merchant(t);return {major:major(v.category),minor:v.minor,scene:v.scene,name:t.correctedMerchant?name:!v.minor?name:''};
 }
 function label(t){if(t.correctedMerchant)return D.merchant(t);const p=parts(t);return [...new Set([p.major,p.minor,p.scene,p.name].filter(Boolean))].join(' · ');}
 function signature(t){const m=TYPES.find(([re])=>re.test(basis({...t,life:{}})));return m?m[2]||'交通未细分':'未细分';}
 function merchantKey(t){const raw=key(t.merchant);return /^地铁(?:[-—]|$)/.test(raw)?'地铁':raw;}
 function prefKey(t){return 'life-pref:v1:'+C.digest([merchantKey(t),signature(t)]);}
 function preference(t,changes){return {key:prefKey(t),value:{version:1,merchant:merchantKey(t),signature:signature(t),category:changes.category,minor:text(changes.minor,16),updatedAt:new Date().toISOString()}};}
 function apply(t,meta=[]){if(t.lifeUser)return t;const p=meta.find(m=>m.key===prefKey(t))?.value;if(!p||p.version!==1||p.merchant!==merchantKey(t)||p.signature!==signature(t)||!C.CATEGORIES.includes(p.category))return t;
  const current=infer(t);return {...t,category:p.category,categoryTentative:false,subcategory:p.minor,life:{...(t.life||{}),category:p.category,minor:p.minor,scene:current.scene},lifeUser:true,lifePreference:prefKey(t)};
 }
 function prepare(raw,t){const l=raw?.life||{};return {...t,evidence:{...t.evidence,detail:text(raw?.evidence?.detail,300)},life:{minor:text(l.minor||raw?.subcategory,16),scene:text(l.scene,24),minorEvidence:text(l.minorEvidence,200),sceneEvidence:text(l.sceneEvidence,200),city:text(l.city,24),cityEvidence:text(l.cityEvidence,200)}};}
 return {major,category,parts,label,infer,prepare,apply,preference,prefKey,signature,normalizeMinor};
});
