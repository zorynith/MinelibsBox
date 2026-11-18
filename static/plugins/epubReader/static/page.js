define(function(require, exports){
	var CSS = '.epubReader-box{display:flex;flex-direction:column;height:100%;background:#fff;}'
		+ '.epubReader-bar{flex:0 0 40px;display:flex;align-items:center;gap:8px;padding:0 10px;'
		+ 'border-bottom:1px solid #eee;font-size:13px;color:#666;}'
		+ '.epubReader-bar a{cursor:pointer;padding:2px 8px;border-radius:4px;user-select:none;}'
		+ '.epubReader-bar a:hover{background:#f2f2f2;}'
		+ '.epubReader-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#333;}'
		+ '.epubReader-body{flex:1;display:flex;min-height:0;}'
		+ '.epubReader-toc{width:220px;overflow:auto;border-right:1px solid #eee;padding:8px;'
		+ 'font-size:13px;display:none;}'
		+ '.epubReader-toc.open{display:block;}'
		+ '.epubReader-toc a{display:block;padding:4px 6px;color:#444;border-radius:3px;}'
		+ '.epubReader-toc a:hover{background:#f5f5f5;}'
		+ '.epubReader-view{flex:1;min-width:0;position:relative;overflow:hidden;}';
	
	var addCSS = function(){
		if(document.getElementById('epubReaderStyle')){ return; }
		var dom = document.createElement('style');
		dom.id = 'epubReaderStyle';
		dom.innerHTML = CSS;
		document.head.appendChild(dom);
	};
	
	var createBox = function(title){
		addCSS();
		var dialog = $.dialog({
			simple:true,
			ico:core.icon('epub'),
			title:title,
			width:'80%',
			height:'85%',
			content:'<div class="epubReader-box">'
				+ '<div class="epubReader-bar">'
				+ '<a class="epubReader-prev">&#8249;</a>'
				+ '<span class="epubReader-title"></span>'
				+ '<span class="epubReader-percent"></span>'
				+ '<a class="epubReader-toc-btn">'+(LNG['epubReader.tips.toc'] || '目录')+'</a>'
				+ '<a class="epubReader-next">&#8250;</a>'
				+ '</div>'
				+ '<div class="epubReader-body">'
				+ '<div class="epubReader-toc"></div>'
				+ '<div class="epubReader-view"></div>'
				+ '</div></div>',
			resize:true,
			padding:0,
			fixed:true
		});
		return dialog;
	};
	
	var playStart = function(fileInfo){
		var dialog = createBox(fileInfo.name);
		var $wrap  = dialog.DOM.wrap;
		$wrap.find('.epubReader-title').text(fileInfo.name);
		var book = null;
		
		var closeFn = function(){
			try{ if(book){ book.destroy(); } }catch(e){}
		};
		var oldClose = dialog.close;
		dialog.close = function(){
			closeFn();
			return oldClose.apply(dialog,arguments);
		};
		
		var tips = function(text){
			$wrap.find('.epubReader-view').html('<div style="padding:20px;color:#999;">'
				+ (text || LNG['epubReader.tips.loadError'] || '电子书加载失败') + '</div>');
		};
		
		setTimeout(function(){
			if(typeof window.ePub !== 'function'){ return tips(); }
			try{
				book = window.ePub(fileInfo.url);
			}catch(e){ return tips(); }
			
			var rendition = book.renderTo($wrap.find('.epubReader-view').get(0),{
				width:'100%',
				height:'100%',
				flow:'paginated',
				spread:'none'
			});
			rendition.display().catch(function(){ tips(); });
			
			rendition.on('relocated',function(location){
				var percent = location && location.start && location.start.percentage;
				$wrap.find('.epubReader-percent').text(percent ? Math.round(percent * 100) + '%' : '');
			});
			
			$wrap.find('.epubReader-prev').on('click',function(){ rendition.prev(); });
			$wrap.find('.epubReader-next').on('click',function(){ rendition.next(); });
			$wrap.find('.epubReader-toc-btn').on('click',function(){
				$wrap.find('.epubReader-toc').toggleClass('open');
			});
			
			book.loaded.navigation.then(function(nav){
				var html = '';
				(nav.toc || []).forEach(function(item){
					var pad = item.level ? (item.level - 1) * 12 : 0;
					html += '<a href="javascript:;" data-href="' + _.escape(item.href) + '"'
						+ ' style="padding-left:' + (6 + pad) + 'px;">'
						+ _.escape(item.label) + '</a>';
				});
				var $toc = $wrap.find('.epubReader-toc').html(html || '');
				$toc.find('a').on('click',function(){
					rendition.display($(this).data('href'));
				});
				if(!html){ $wrap.find('.epubReader-toc-btn').hide(); }
			}).catch(function(){});
			
			book.ready.then(function(){
				var meta = book.packaging && book.packaging.metadata;
				if(meta && meta.title){ $wrap.find('.epubReader-title').text(meta.title); }
			}).catch(function(){});
		},50);
	};
	
	var playReady = function(appStatic,fileInfo){
		requireAsync([appStatic + 'lib/jszip.min.js',appStatic + 'lib/epub.min.js'],function(){
			playStart(fileInfo);
		});
	};
	return playReady;
});
