/* 展示层的轻整理：只生成短名称和日期标签，不改交易身份、来源或金额。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ShijianDisplay=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const tidy=x=>typeof x==='string'?x.normalize('NFKC').trim().replace(/\s+/g,' '):'';
 const clip=(s,n=8)=>[...s].length>n?[...s].slice(0,n).join('')+'…':s;
 function merchant(t){
  // 人工改名优先；长名称仅由CSS作单行裁切，编辑时仍取得原值。
  if(t.correctedMerchant)return tidy(t.correctedMerchant);
  const original=tidy(t.merchant),alias=tidy(t.displayName);let s=alias||original;
  if(/地铁/.test(original)||/地铁/.test(s))return '地铁';
  const brands=['良品铺子','金山WPS','WPS','智谱','星巴克','瑞幸咖啡','滴滴出行','美团','京东','麦当劳','肯德基','盒马','山姆'];
  const brand=brands.find(b=>s.toLowerCase().includes(b.toLowerCase())||original.toLowerCase().includes(b.toLowerCase()));if(brand)return brand;
  s=s.replace(/^(?:微信支付|支付宝|扫二维码付款|扫码付款|二维码付款|商户收款|付款|转账)[\s:：\-—]*(?:给)?/,'').replace(/^给(?=\S)/,'');
  s=s.replace(/\d{4}[年/.\-]\d{1,2}[月/.\-]\d{1,2}日?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?/g,'').replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g,'');
  s=s.replace(/\([^)]*(?:分店|门店|店)[^)]*\)$/,'').replace(/(?:股份有限公司|有限责任公司|有限公司)$/,'').replace(/(?:[-—:：\s]*[A-Za-z]*\d{10,})+/g,'').replace(/^[\s\-—:：]+|[\s\-—:：.。…]+$/g,'').trim();
  if(!s||!/[\p{L}]/u.test(s))s='一笔消费';
  return clip(s,8);
 }
 function photoTitle(value,fallback=''){
  const input=tidy(value).replace(/<[^>]*>/g,''),text=tidy(fallback||value).replace(/<[^>]*>/g,'');
  if(input&&[...input].length<=16&&!/[，。！？；:：]/.test(input)&&!/^(?:抬头时|今天|这张|画面中|照片中|这一刻)/.test(input))return input;
  if(/粉[红色]?/.test(text)&&/花/.test(text)&&/蓝天|湛蓝|天空/.test(text))return '粉花映着蓝天';
  if(/花/.test(text)&&/枝|树/.test(text))return '枝头的花';
  if(/书页|书本/.test(text)&&/光|阳/.test(text))return '书页上的光';
  if(/海/.test(text)&&/日落|落日|夕阳/.test(text))return '海面与落日';
  if(/咖啡/.test(text))return '咖啡片刻';
  const clauses=text.split(/[，。！？；、:：]/).map(x=>x.trim()).filter(x=>[...x].length>=3&&[...x].length<=14&&!/^(?:抬头时|今天|这张|照片中|画面中|这一刻)/.test(x));
  if(clauses.length)return clauses[0];
  const nouns=['蓝天','花朵','枝桠','树干','书页','灯光','街道','云','湖面','月亮','窗边','雨滴','山峰','河岸'];const seen=nouns.filter(n=>text.includes(n));if(seen.length>=2)return seen[0]+'与'+seen[1];if(seen.length)return seen[0]+'一隅';
  const first=text.split(/[，。！？；]/)[0].replace(/^(?:抬头时|今天|这张照片中|画面中|照片中)[,，\s]*/,'').trim();return [...first].length<=14?first:clip(first,10);
 }
 function dayLabel(p,now=new Date()){
  if(/^\d{4}-(0[1-9]|1[0-2])$/.test(p||''))return '本月';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(p||''))return '未注明';
  const [y,m,d]=p.split('-').map(Number),day=new Date(y,m-1,d);if(day.getFullYear()!==y||day.getMonth()!==m-1||day.getDate()!==d)return '未注明';
  const delta=(Date.UTC(y,m-1,d)-Date.UTC(now.getFullYear(),now.getMonth(),now.getDate()))/86400000;
  return delta===0?'今天':delta===-1?'昨天':delta===1?'明天':d+'日';
 }
 return {merchant,photoTitle,dayLabel,clip};
});
