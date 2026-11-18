define(function(require, exports){
	var CSS = '.emlViewer-box{display:flex;flex-direction:column;height:100%;background:#fff;font-size:13px;color:#333;}'
		+ '.emlViewer-head{flex:0 0 auto;padding:10px 14px;border-bottom:1px solid #eee;line-height:1.7;}'
		+ '.emlViewer-head b{color:#111;font-weight:600;}'
		+ '.emlViewer-sub{font-size:14px;font-weight:600;margin-bottom:4px;word-break:break-all;}'
		+ '.emlViewer-meta{color:#777;}'
		+ '.emlViewer-files{padding:6px 14px;border-bottom:1px solid #eee;}'
		+ '.emlViewer-files a{display:inline-block;margin:2px 8px 2px 0;padding:2px 8px;border:1px solid #e5e5e5;'
		+ 'border-radius:12px;color:#337ab7;}'
		+ '.emlViewer-body{flex:1;min-height:0;position:relative;}'
		+ '.emlViewer-body iframe{width:100%;height:100%;border:0;background:#fff;}'
		+ '.emlViewer-tips{padding:16px;color:#999;}';
	
	var addCSS = function(){
		if(document.getElementById('emlViewerStyle')){ return; }
		var dom = document.createElement('style');
		dom.id = 'emlViewerStyle';
		dom.innerHTML = CSS;
		document.head.appendChild(dom);
	};
	
	// ---------- MIME 解析 ----------
	var binToBytes = function(str){
		var out = new Uint8Array(str.length);
		for(var i = 0; i < str.length; i++){ out[i] = str.charCodeAt(i) & 0xff; }
		return out;
	};
	var bytesToBin = function(bytes){
		var arr = [], step = 8192;
		for(var i = 0; i < bytes.length; i += step){
			arr.push(String.fromCharCode.apply(null, bytes.subarray(i, i + step)));
		}
		return arr.join('');
	};
	var decodeText = function(bytes, charset){
		charset = (charset || 'utf-8').replace(/^["']|["']$/g, '');
		try{ return new TextDecoder(charset).decode(bytes); }
		catch(e){
			try{ return new TextDecoder('utf-8').decode(bytes); }
			catch(e2){ return bytesToBin(bytes); }
		}
	};
	var qpToBytes = function(str){
		var s = String(str).replace(/=\r?\n/g, '');
		var out = [];
		for(var i = 0; i < s.length; i++){
			var c = s.charAt(i);
			var hex = s.substr(i + 1, 2);
			if(c === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)){
				out.push(parseInt(hex, 16));
				i += 2;
			}else{
				out.push(s.charCodeAt(i) & 0xff);
			}
		}
		return new Uint8Array(out);
	};
	var decodeWords = function(str){
		return String(str || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function(all, charset, enc, data){
			try{
				var bytes = (enc.toUpperCase() === 'B')
					? binToBytes(atob(data))
					: qpToBytes(data.replace(/_/g, ' '));
				return decodeText(bytes, charset);
			}catch(e){ return all; }
		});
	};
	var parseParams = function(value){
		var out = { value:'', params:{} };
		var segs = String(value || '').split(';');
		out.value = String(segs.shift() || '').trim().toLowerCase();
		for(var i = 0; i < segs.length; i++){
			var m = segs[i].match(/^\s*([^=]+)=(?:"([\s\S]*)"|([^;]*))\s*$/);
			if(m){
				var key = m[1].toLowerCase().trim();
				out.params[key] = (m[2] !== undefined ? m[2] : m[3]).trim();
			}
		}
		return out;
	};
	var parsePart = function(raw){
		var idx = raw.search(/\r?\n\r?\n/);
		var head = idx < 0 ? raw : raw.slice(0, idx);
		var body = idx < 0 ? '' : raw.slice(idx + (raw.substr(idx, 4) === '\r\n\r\n' ? 4 : 2));
		var headers = {}, last = null;
		var lines = head.split(/\r?\n/);
		for(var i = 0; i < lines.length; i++){
			var line = lines[i];
			if(/^[ \t]/.test(line) && last){
				headers[last] += ' ' + line.replace(/^[ \t]+/, '').trim();
				continue;
			}
			var m = line.match(/^([^:]+):\s*([\s\S]*)$/);
			if(!m){ continue; }
			last = m[1].toLowerCase().trim();
			headers[last] = m[2];
		}
		return { headers:headers, body:body, raw:raw };
	};
	var decodePartBody = function(part){
		var cte = String(part.headers['content-transfer-encoding'] || '').toLowerCase().trim();
		if(cte === 'base64'){
			var clean = part.body.replace(/[^A-Za-z0-9+/=]/g, '');
			try{ return binToBytes(atob(clean)); }catch(e){ return new Uint8Array(0); }
		}
		if(cte === 'quoted-printable'){ return qpToBytes(part.body); }
		return binToBytes(part.body);
	};
	var walkParts = function(raw, out){
		var part = parsePart(raw);
		var ct = parseParams(part.headers['content-type'] || 'text/plain');
		if(ct.value.indexOf('multipart/') === 0 && ct.params.boundary){
			var sep = '--' + ct.params.boundary;
			var segs = part.body.split(sep);
			for(var i = 1; i < segs.length; i++){
				if(segs[i].indexOf('--') === 0){ break; }
				walkParts(segs[i].replace(/^\r?\n/, ''), out);
			}
			return out;
		}
		out.push({
			headers: part.headers,
			type: ct.value || 'text/plain',
			params: ct.params,
			bytes: decodePartBody(part)
		});
		return out;
	};
	
	var escHtml = function(str){
		return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
			.replace(/>/g,'&gt;').replace(/"/g,'&quot;');
	};
	var readTextPart = function(item){
		return decodeText(item.bytes, item.params.charset);
	};
	var fileNameOf = function(item){
		var disp = String(item.headers['content-disposition'] || '');
		var m = disp.match(/filename\*?=(?:[^;]*'[^']*')?"?([^";]+)"?/i);
		var name = m ? m[1] : (item.params.name || '');
		if(/filename\*=/i.test(disp)){
			try{ name = decodeURIComponent(name); }catch(e){}
		}
		return decodeWords(name);
	};
	var isAttachment = function(item){
		var disp = String(item.headers['content-disposition'] || '').toLowerCase();
		return disp.indexOf('attachment') === 0 || !!fileNameOf(item);
	};
	
	var renderMail = function($wrap, fileInfo){
		var $head = $wrap.find('.emlViewer-head');
		var $files = $wrap.find('.emlViewer-files');
		var $body  = $wrap.find('.emlViewer-body');
		$head.html('<div class="emlViewer-tips">' + (LNG['emlViewer.tips.loading'] || '正在解析邮件...') + '</div>');
		
		var fail = function(){
			$head.html('<div class="emlViewer-tips">' + (LNG['emlViewer.tips.loadError'] || '邮件解析失败') + '</div>');
		};
		
		fetch(fileInfo.url, {credentials:'same-origin'}).then(function(res){
			if(!res.ok){ throw new Error('http ' + res.status); }
			return res.arrayBuffer();
		}).then(function(buffer){
			var bin = bytesToBin(new Uint8Array(buffer));
			var root = parsePart(bin);
			var items = walkParts(bin, []);
			
			var subject = decodeWords(root.headers['subject'] || '');
			var from    = decodeWords(root.headers['from'] || '');
			var to      = decodeWords(root.headers['to'] || '');
			var date    = root.headers['date'] || '';
			
			$head.html(''
				+ '<div class="emlViewer-sub">' + escHtml(subject || fileInfo.name) + '</div>'
				+ '<div class="emlViewer-meta">'
				+ '<b>' + (LNG['emlViewer.tips.from'] || '发件人') + ':</b> ' + escHtml(from) + '<br/>'
				+ '<b>' + (LNG['emlViewer.tips.to'] || '收件人') + ':</b> ' + escHtml(to) + '<br/>'
				+ '<b>' + (LNG['emlViewer.tips.date'] || '时间') + ':</b> ' + escHtml(date)
				+ '</div>');
			
			var attach = items.filter(isAttachment);
			if(attach.length){
				$files.show();
				attach.forEach(function(item, index){
					var name = fileNameOf(item) || ('attachment-' + (index + 1));
					var blob = new Blob([item.bytes], {type:item.type || 'application/octet-stream'});
					var url  = URL.createObjectURL(blob);
					var $a = $('<a></a>').attr({href:url, download:name}).text(name);
					$files.append($a);
				});
			}else{
				$files.hide();
			}
			
			// 内嵌图片 cid: 映射
			var cidMap = {};
			items.forEach(function(item){
				var cid = String(item.headers['content-id'] || '').replace(/^<|>$/g, '');
				if(cid && item.type.indexOf('image/') === 0){
					cidMap[cid] = 'data:' + item.type + ';base64,' + btoa(bytesToBin(item.bytes));
				}
			});
			
			var htmlPart = null, textPart = null;
			items.forEach(function(item){
				if(isAttachment(item)){ return; }
				if(item.type === 'text/html'){ htmlPart = item; }
				if(item.type === 'text/plain'){ textPart = item; }
			});
			
			var content = '';
			if(htmlPart){
				content = readTextPart(htmlPart);
				content = content.replace(/cid:([^"'\s)>]+)/gi, function(all, cid){
					var key = decodeURIComponent(cid);
					return cidMap[key] || cidMap[cid] || all;
				});
			}else if(textPart){
				content = '<pre style="white-space:pre-wrap;word-break:break-word;font:13px/1.6 monospace;padding:14px;">'
					+ escHtml(readTextPart(textPart)) + '</pre>';
			}else{
				content = '<div class="emlViewer-tips">' + (LNG['emlViewer.tips.empty'] || '邮件正文为空') + '</div>';
			}
			
			var csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';img-src data:;style-src 'unsafe-inline';\">";
			var doc = '<!doctype html><html><head><meta charset="utf-8">' + csp
				+ '<style>body{margin:0;padding:14px;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;'
				+ 'color:#222;word-break:break-word;}img{max-width:100%;height:auto;}'
				+ 'table{max-width:100%;}</style></head><body>' + content + '</body></html>';
			
			var iframe = document.createElement('iframe');
			iframe.setAttribute('sandbox', '');
			iframe.setAttribute('referrerpolicy', 'no-referrer');
			iframe.srcdoc = doc;
			$body.empty().append(iframe);
		}).catch(fail);
	};
	
	var playReady = function(appStatic, fileInfo){
		addCSS();
		var dialog = $.dialog({
			simple:true,
			ico:core.icon('eml'),
			title:fileInfo.name,
			width:'70%',
			height:'80%',
			content:'<div class="emlViewer-box">'
				+ '<div class="emlViewer-head"></div>'
				+ '<div class="emlViewer-files" style="display:none;"></div>'
				+ '<div class="emlViewer-body"></div>'
				+ '</div>',
			resize:true,
			padding:0,
			fixed:true
		});
		renderMail(dialog.DOM.wrap, fileInfo);
	};
	return playReady;
});
