'use strict';
const express=require('express'),{randomBytes,timingSafeEqual}=require('crypto');
/* 仅短期接收客户端密文：不写盘，不收解密密钥；单实例内存限额与失效清理。 */
function createRelay({clock=Date.now,ttl=10*60*1000,maxBytes=50*1024*1024,maxTotal=64*1024*1024}={}){
 const router=express.Router(),items=new Map(),rates=new Map();let bytes=0,inflight=0;
 function sweep(){for(const [id,item]of items)if(item.expires<=clock()){bytes-=item.cipher.length;items.delete(id);}for(const [key,r]of rates)if(r.until<=clock())rates.delete(key);}
 const timer=setInterval(sweep,30000);timer.unref();
 router.use((req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});sweep();next();});
 router.post('/',(req,res,next)=>{const origin=req.get('origin');if(req.get('X-Shijian-Relay')!=='1'||origin&&new URL(origin).host!==req.get('host'))return res.status(403).json({message:'请从拾间页面主动发起传送。'});if(rates.size>5000&&!rates.has(req.ip))return res.status(503).json({message:'临时传送繁忙，请稍后再试。'});const key=req.ip,r=rates.get(key)||{count:0,until:clock()+ttl};if(r.count>=5)return res.status(429).json({message:'传送次数较多，请稍后再试。'});r.count++;rates.set(key,r);const requested=Number(req.get('content-length'));if(!Number.isSafeInteger(requested)||requested<32||requested>maxBytes+1024*1024)return res.status(413).json({message:'传送文件超过当前支持范围。'});if(bytes+inflight+requested>maxTotal)return res.status(503).json({message:'临时传送空间正在使用，请稍后再试。'});inflight+=requested;let released=false;const release=()=>{if(!released){released=true;inflight-=requested;}};req.once('aborted',release);res.once('close',release);next();},express.raw({type:'application/octet-stream',limit:maxBytes+1024*1024}),(req,res)=>{
  if(!Buffer.isBuffer(req.body)||req.body.length<32||req.body.length>maxBytes+1024*1024)return res.status(400).json({message:'传送内容不完整，请在原设备重新准备。'});
  if(bytes+req.body.length>maxTotal)return res.status(503).json({message:'临时传送空间不足，请保留原记录，稍后再试。'});
  const id=randomBytes(24).toString('base64url'),secret=randomBytes(24).toString('base64url'),expires=clock()+ttl;items.set(id,{cipher:req.body,secret,expires,received:false});bytes+=req.body.length;res.status(201).json({id,secret,expires});
 });
 router.get('/:id',(req,res)=>{const item=items.get(req.params.id);if(!item)return res.status(404).json({message:'这次传送已到期或已撤回，请在原设备重新发起。'});if(req.query.status==='1')return res.json({received:item.received,expires:item.expires});res.type('application/octet-stream').send(item.cipher);});
 router.post('/:id/received',express.json({limit:'1kb'}),(req,res)=>{const item=items.get(req.params.id);if(!item)return res.sendStatus(404);item.received=true;res.json({ok:true});});
 router.delete('/:id',(req,res)=>{const item=items.get(req.params.id),value=req.get('X-Shijian-Cancel')||'';if(!item)return res.sendStatus(204);if(!/^[A-Za-z0-9_-]{32}$/.test(value)||!timingSafeEqual(Buffer.from(value),Buffer.from(item.secret)))return res.sendStatus(403);bytes-=item.cipher.length;items.delete(req.params.id);res.sendStatus(204);});
 return{router,close:()=>{clearInterval(timer);items.clear();rates.clear();bytes=0;}};
}
module.exports={createRelay};
