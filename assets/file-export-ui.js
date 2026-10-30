/* 文件交付只响应用户点击；下载/分享不冒充已经保存，不上传备份。 */
(function(){'use strict';window.ShijianFileExport={create(d){const {node,button,modal,toast}=d;
 function present(blob,name,{backup=false,onConfirmed}={}){const root=modal(backup?'把这一份生活保存好':'保存记账表格'),wechat=/MicroMessenger/i.test(navigator.userAgent),status=node('p','muted');status.setAttribute('role','status');
  root.append(node('p','detail-text',backup?'时光、轨迹、原始图片、草稿和个人设置，都在这一份完整备份里。':'这是供表格查看的记账数据，不能替代完整备份恢复生活记录。'),node('p','muted',name+' · '+(blob.size/1024).toFixed(1)+' KB'),node('p','review-note','文件包含私人内容与真实金额，请选自己信任的保存位置。'));
  let file;try{const candidates=[new File([blob],name,{type:blob.type||'application/octet-stream'}),new File([blob],name+'.txt',{type:'text/plain'})];file=candidates.find(f=>navigator.share&&navigator.canShare?.({files:[f]}));}catch(_){}
  if(wechat)root.append(node('p','detail-text','微信内的下载入口因手机版本而异，网页无法确认文件是否真正落盘。优先选择下方可用的保存方式；下载后请在下载列表或“文件”中搜索文件名。'),node('p','muted','先在当前入口保留备份。换浏览器不会自动带走微信中的本机记录，不要清除网站数据。'));
  root.append(status);let working=false;
  const confirm=async()=>{await onConfirmed?.();status.textContent='已记下你的确认，请妥善保管这份文件。';toast('备份保存位置已确认。');};
  if(typeof window.showSaveFilePicker==='function')root.append(button('选择保存位置',async()=>{if(working)return;working=true;try{const handle=await window.showSaveFilePicker({suggestedName:name}),stream=await handle.createWritable();await stream.write(blob);await stream.close();status.textContent='已写入你选择的文件。';await onConfirmed?.();}catch(e){status.textContent=e.name==='AbortError'?'这次没有选择保存位置，记录仍在原处。':'这次没有完成保存，可以换用下方方式。';}finally{working=false;}},'primary-button'));
  if(file)root.append(button('选择系统保存或分享',async()=>{if(working)return;working=true;try{await navigator.share({files:[file]});status.textContent='已交给系统处理，请确认保存位置；分享完成不等于已保存备份。'+(file.name.endsWith('.json.txt')?' 此方式可能保存为 .json.txt，仍可导入恢复。':'');}catch(e){status.textContent=e.name==='AbortError'?'这次先不保存，记录仍在原处。':'系统暂未接收文件，请尝试其他方式。';}finally{working=false;}},'primary-button'));
  root.append(button(wechat?'尝试浏览器下载':'下载文件',()=>{const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='已发起下载，尚未确认保存。请在浏览器下载列表或“文件”中查找 '+name+'。';},file?'quiet-button':'primary-button'));
  if(backup)root.append(button('我已找到保存的文件',()=>{void confirm().catch(e=>{status.textContent=e.message;});}));
  if(wechat&&backup){const fallback=node('details','reflection');fallback.append(node('summary','','暂时存不下文件？用备份文本带走'));
   fallback.append(node('p','muted','文本与JSON文件内容相同，也包含原图。可复制到自己的电脑，保存为 .json 或 .txt 文件后导入。不要发到公开位置。'));
   if(blob.size<=2*1024*1024){const show=button('准备完整备份文本',async()=>{show.disabled=true;try{const value=await blob.text();if(!root.isConnected)return;const area=node('textarea','backup-text');area.readOnly=true;area.value=value;area.setAttribute('aria-label','完整备份文本');const copy=button('复制完整备份文本',async()=>{try{await navigator.clipboard.writeText(value);status.textContent='备份文本已复制。请先粘贴并保存到自己的文件，再确认备份；此处不视为已完成保存。';}catch(_){area.focus();area.select();status.textContent='请长按全选并复制，再保存到自己的文件中。';}});fallback.append(area,copy);show.remove();}catch(_){status.textContent='暂时没能准备文本，记录仍在原处。';show.disabled=false;}});fallback.append(show);}else fallback.append(node('p','muted','这份备份超过2 MB，不展开大段文本，以免手机卡顿。请使用上方可用的系统文件保存或分享功能；当前记录仍留在此入口。'));
   root.append(fallback);
  }
  root.append(node('p','muted','没有找到文件时，请保留当前入口和记录；不要把“已发起下载”当成备份完成。'));return root;
 }
 return {present};
}};})();
