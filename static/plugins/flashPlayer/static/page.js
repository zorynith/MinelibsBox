define(function(require, exports){
	/*
	 * Ruffle 运行时加载: 官方包体积约 14M(wasm), 不随插件分发,
	 * 优先使用后台配置的 cdn, 失败后依次尝试公共镜像。
	 */
	var CDN_FALLBACK = [
		'https://cdn.jsdelivr.net/npm/@ruffle-rs/ruffle@0.7.1/'
	];
	var ruffleReady = function(){
		return !!(window.RufflePlayer && window.RufflePlayer.newest);
	};
	var loadScript = function(base,ok,fail){
		var dom = document.createElement('script');
		dom.src = base + 'ruffle.js';
		dom.async = true;
		dom.onload = function(){ ok(); };
		dom.onerror = function(){ dom.parentNode && dom.parentNode.removeChild(dom); fail(); };
		document.head.appendChild(dom);
	};
	var ensureRuffle = function(localBase,cdn,callback){
		if(ruffleReady()){ return callback(null); }
		var list = [], add = function(url){
			url = (url || '').replace(/\/+$/,'') + '/';
			if(url && list.indexOf(url) < 0){ list.push(url); }
		};
		add(localBase);   // 优先使用插件内置的 ruffle
		add(cdn);         // 后台指定的外部地址(可选)
		for(var i = 0; i < CDN_FALLBACK.length; i++){ add(CDN_FALLBACK[i]); }
		
		var index = 0;
		var next = function(){
			if(index >= list.length){ return callback(true); }
			var base = list[index++];
			loadScript(base,function(){
				ruffleReady() ? callback(null) : next();
			},next);
		};
		next();
	};
	
	var createDialog = function(title){
		var dialog = $.dialog({
			simple:true,
			ico:core.icon('swf'),
			title:title,
			width:'70%',
			height:'60%',
			content:'<div class="flashPlayer-box" style="width:100%;height:100%;background:#000;overflow:hidden;"></div>',
			resize:true,
			padding:0,
			fixed:true
		});
		dialog.DOM.wrap.addClass('flashPlayer-dialog');
		return dialog.DOM.wrap.find('.flashPlayer-box');
	};
	
	var playStart = function(fileInfo,localBase){
		var $box   = createDialog(fileInfo.name);
		var $mask  = $('<div style="position:absolute;left:0;top:0;right:0;bottom:0;'
			+'color:#fff;display:flex;align-items:center;justify-content:center;">'
			+'<span class="flashPlayer-tips"></span></div>');
		$box.append($mask);
		var tips = function(text){
			$mask.find('.flashPlayer-tips').html(text || '');
			$mask.show();
		};
		var errorTips = function(){
			tips(LNG['flashPlayer.tips.loadError'] || 'Ruffle 加载失败, 请检查网络或后台配置的 CDN 地址');
		};
		
		ensureRuffle(localBase,fileInfo.cdn,function(err){
			if(err){ return errorTips(); }
			var player;
			try{
				player = window.RufflePlayer.newest().createPlayer();
			}catch(e){ return errorTips(); }
			player.style.width  = '100%';
			player.style.height = '100%';
			$box.get(0).appendChild(player);
			$mask.hide();
			
			try{
				player.load({
					url:fileInfo.url,
					autoplay:fileInfo.autoplay === '1',
					letterbox:'on',
					unmuteOverlay:'hidden',
					contextMenu:'rightClick',
					splashScreen:true,
					logLevel:'error'
				});
			}catch(e){ errorTips(); }
		});
	};
	
	var playReady = function(appStatic,fileInfo){
		playStart(fileInfo,appStatic + 'ruffle/');
	};
	return playReady;
});
