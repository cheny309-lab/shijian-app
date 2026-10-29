/* 生活剧本的纯展示规则：时间顺序、城市依据、按日汇总。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./ledger-core'),require('./trajectory-core'));else root.ShijianStory=factory(root.LedgerCore,root.TrajectoryCore);})(typeof globalThis!=='undefined'?globalThis:this,function(C,T){
 'use strict';
 const text=(v,n=300)=>C.clean(v,n).normalize('NFKC').trim();
 function cityName(value){const s=text(value,40);return /^[\p{L}\p{M}\s·.'’-]{1,24}$/u.test(s)?s.replace(/市$/,'').trim():'';}
 function parseCities(value){if(!text(value,300))return [];const parts=text(value,300).split(/[，,、;；/／·]+/).map(s=>s.trim()).filter(Boolean);if(parts.length>6)throw Error('可以先留下六处地点，其他细节也可以写进自己的话里。');const out=parts.map(cityName);if(out.some(s=>!s))throw Error('写下城市名称即可，多个城市用顿号分开。');return [...new Set(out)];}
 function city(t){if(t.cityUser===true)return cityName(t.city);const l=t.life||{},name=cityName(l.city),quote=text(l.cityEvidence),detail=text(t.evidence?.detail);if(!name||!quote||!detail.includes(quote)||!quote.includes(name))return '';
  // 企业名称、注册信息与线上收发货地址，不等于人所在的城市。
  if(/公司|股份|注册|收款方|企业地址|发货|收货/.test(quote)||[t.merchant,t.evidence?.merchant].some(m=>text(m)===quote))return '';
  return name;
 }
 const placeKey=day=>'day-place:v1:'+day;
 function cities(groups,meta,day){const pref=meta.find(m=>m.key===placeKey(day))?.value;if(pref?.mode==='manual')return [...new Set((Array.isArray(pref.cities)?pref.cities:[]).map(cityName).filter(Boolean))];return [...new Set(groups.flatMap(g=>g.rows).map(city).filter(Boolean))];}
 function time(g){const t=g.row,d=C.date(t.occurredAt);return !t.dateAssigned&&g.period?.length===10&&t.occurredAt?.slice(0,10)===g.period&&d?.precision==='time'?d.timestamp:null;}
 function order(groups){const known=groups.filter(g=>time(g)!==null).sort((a,b)=>time(a)-time(b)),out=[];let i=0;for(const g of groups)out.push(time(g)!==null?known[i++]:g);return out;}
 function daySummary(groups,day){if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!C.date(day))return null;const exact=groups.filter(g=>g.period===day),sum=T.summary(exact.flatMap(g=>g.rows),day.slice(0,7));return {...sum,count:exact.length};}
 return {cityName,parseCities,city,placeKey,cities,order,daySummary};
});
