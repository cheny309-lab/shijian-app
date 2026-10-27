/* 桌面入口：只响应用户操作，无自动安装弹窗，无缓存与离线承诺。 */
(function(){'use strict';
    let pending=null,installed=false;
    window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();pending=event;window.dispatchEvent(new Event('shijian-install-ready'));});
    window.addEventListener('appinstalled',()=>{pending=null;installed=true;window.dispatchEvent(new Event('shijian-install-ready'));});
    const standalone=()=>installed||window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
    function platform(ua=navigator.userAgent){if(/MicroMessenger/i.test(ua))return 'wechat';if(/iPhone|iPad|iPod/i.test(ua)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)return 'ios';if(/Android/i.test(ua))return 'android';return 'desktop';}
    function create(d){const {node,button,modal,toast}=d;
        function open(){const box=modal('把拾间放到桌面'),icon=node('img','desktop-icon');icon.src='/assets/icons/icon-192.png';icon.alt='拾间图标';box.append(icon,node('p','detail-text','以后，点一下图标，就能回到拾间。'));
            box.append(node('p','review-note','先留一份完整备份。微信、其他浏览器和桌面入口可能分别保存记录；iPhone桌面网页与Safari的记录不会自动共用。添加后若内容为空，请导入备份，原入口先保留。'));
            box.append(button('先导出完整备份',()=>{void d.exportBackup();}));
            const p=platform();
            if(standalone())box.append(node('p','muted','你已在桌面窗口中打开拾间。'));
            else if(p==='wechat')box.append(node('p','detail-text','请点微信右上角“…”→ 在浏览器打开。若没有这个选项，可复制下方地址，在安卓浏览器或iPhone的Safari中打开后添加。'));
            else if(p==='ios')box.append(node('p','detail-text','在Safari中打开拾间 → 分享 → 添加到主屏幕。若出现“作为网页App打开”，可以开启。不同系统版本的按钮位置可能不同。'));
            else if(p==='android')box.append(node('p','detail-text','打开浏览器菜单，寻找“添加到主屏幕”“添加到桌面”或“安装应用”。是否支持独立窗口，由浏览器决定。'));
            else box.append(node('p','detail-text','Chrome或Edge中，可寻找地址栏的安装图标，或菜单里的“安装拾间／将此网站安装为应用”。手机上也可以打开下方地址添加到桌面。'));
            if(!standalone()&&p!=='wechat'&&p!=='ios'&&pending){const install=button('添加拾间到桌面',async()=>{const event=pending;if(!event)return;pending=null;install.disabled=true;try{await event.prompt();const choice=await event.userChoice;toast(choice?.outcome==='accepted'?'已交给浏览器添加，请查看桌面。':'这次先不添加，随时可以回来。');}catch(_){toast('可以通过浏览器菜单添加到桌面。');}finally{install.disabled=false;open();}},'primary-button');box.append(install);}
            const address=node('input');address.value=location.origin+'/';address.readOnly=true;address.setAttribute('aria-label','拾间地址');box.append(address,button('复制拾间地址',async()=>{try{await navigator.clipboard.writeText(address.value);toast('地址已复制。');}catch(_){address.focus();address.select();toast('请长按地址复制。');}}));
            box.append(node('p','muted','桌面入口仍需联网打开；AI识别也需要网络。添加图标不等于云同步，本机记录请继续备份。'));
        }
        return {open,standalone,platform};
    }
    window.ShijianDesktop={create,standalone,platform};
})();
