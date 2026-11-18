kodReady.push(function(){
	var OPT = {};
	try{ OPT = jsonDecode(urlDecode("{{config}}")) || {}; }catch(e){ OPT = {}; }
	if(String(OPT.enable) === '0'){ return; }
	
	var conf = {
		text:     OPT.text || '{user} {date}',
		fontSize: parseInt(OPT.fontSize,10) || 18,
		opacity:  (parseInt(OPT.opacity,10) || 12) / 100,
		rotate:   parseInt(OPT.rotate,10),
		gap:      parseInt(OPT.gap,10) || 180,
		color:    OPT.color || '#000000'
	};
	if(isNaN(conf.rotate)){ conf.rotate = -22; }
	
	var userText = function(){
		var user = (window.G && G.user) || {};
		var info = user.info || {};
		return info.nickname || info.name || ('#' + (user.userID || ''));
	};
	var two = function(n){ return n < 10 ? '0' + n : '' + n; };
	var dateText = function(){
		var d = new Date();
		return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
	};
	var timeText = function(){
		var d = new Date();
		return two(d.getHours()) + ':' + two(d.getMinutes());
	};
	var renderText = function(){
		return String(conf.text)
			.split('{user}').join(userText())
			.split('{date}').join(dateText())
			.split('{time}').join(timeText());
	};
	
	// 用 canvas 生成一个水印平铺块, 避免大量 DOM 节点;
	// 画布尺寸必须容纳"旋转后"的文字外接框, 否则文字两端会被裁掉(如 administrator => dministrator);
	var buildTile = function(){
		var text = renderText();
		var font = conf.fontSize + 'px sans-serif';
		
		// 先量一次文字尺寸(离屏画布);
		var measure = document.createElement('canvas').getContext('2d');
		measure.font = font;
		var textW = Math.ceil(measure.measureText(text).width) || 0;
		var textH = Math.ceil(conf.fontSize * 1.2);
		
		var rad = conf.rotate * Math.PI / 180;
		var cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
		var boxW = textW * cos + textH * sin;
		var boxH = textW * sin + textH * cos;
		
		// 平铺间距不小于文字外接框, 再留 12px 余量防止相邻水印粘连;
		var pad = 12;
		var w = Math.max(conf.gap, Math.ceil(boxW) + pad * 2);
		var h = Math.max(80, Math.ceil(boxH) + pad * 2);
		
		var ratio = Math.min(window.devicePixelRatio || 1, 2);
		var canvas = document.createElement('canvas');
		canvas.width  = w * ratio;
		canvas.height = h * ratio;
		var ctx = canvas.getContext('2d');
		ctx.scale(ratio, ratio);
		ctx.globalAlpha = conf.opacity;
		ctx.fillStyle   = conf.color;
		ctx.font        = font;
		ctx.textAlign   = 'center';
		ctx.textBaseline = 'middle';
		ctx.translate(w / 2, h / 2);
		ctx.rotate(rad);
		ctx.fillText(text, 0, 0);
		return canvas.toDataURL('image/png');
	};
	
	var tileCache = '', tileTime = 0;
	var tile = function(){
		var now = Date.now();
		if(!tileCache || now - tileTime > 60000){
			tileCache = buildTile();
			tileTime  = now;
		}
		return tileCache;
	};
	
	var styleReady = false;
	var addStyle = function(){
		if(styleReady){ return; }
		styleReady = true;
		var dom = document.createElement('style');
		dom.innerHTML = '.waterMark-layer{position:absolute!important;left:0;top:0;right:0;bottom:0;'
			+ 'pointer-events:none!important;user-select:none;z-index:9998;background-repeat:repeat;}';
		document.head.appendChild(dom);
	};
	
	// 只给"预览类"容器加水印: 内部含 iframe/canvas/图片/播放器;
	var isPreviewBox = function(box){
		if(!box || box.nodeType !== 1 || !box.querySelector){ return false; }
		if(box.querySelector('.waterMark-layer')){ return false; }
		return !!box.querySelector('iframe,canvas,video,.waterMarkTarget,.pdfViewer,.webOffice');
	};
	var decorate = function(box){
		if(!isPreviewBox(box)){ return; }
		addStyle();
		if(window.getComputedStyle(box).position === 'static'){
			box.style.position = 'relative';
		}
		var layer = document.createElement('div');
		layer.className = 'waterMark-layer';
		layer.style.backgroundImage = 'url("' + tile() + '")';
		box.appendChild(layer);
	};
	
	var scan = function(){
		var list = document.querySelectorAll('[class*="dialog"],[class*="Dialog"]');
		for(var i = 0; i < list.length; i++){
			decorate(list[i]);
		}
	};
	
	var scanDelay = null;
	var scanSoon = function(){
		if(scanDelay){ return; }
		scanDelay = setTimeout(function(){
			scanDelay = null;
			scan();
		},200);
	};
	
	if(window.MutationObserver){
		new MutationObserver(scanSoon).observe(document.body,{childList:true,subtree:true});
	}
	setTimeout(scan,500);
	setTimeout(scan,1500);
	Events.bind('explorer.kodApp.before',function(){ setTimeout(scan,300); });
});
