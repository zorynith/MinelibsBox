(function(){
	var fileOpenTitle = LNG['explorer.selectFile'] || "选择文件...";
	var fileApi = {
		ext:'edraw',allowExt:'edraw,excalidraw,excalidrawlib',
		open:function(){
			kodApi.fileSelect({
				title:fileOpenTitle,
				allowExt:fileApi.allowExt,
				callback:function(result){  // 回调地址;
					FILE_INFO = {
						fileUrl:result.downloadPath,
						fileName:result.name,
						savePath:result.path,
						canWrite:true
					};
					fileApi.loadFile();
				}
			});
		},
		
		loadFile:function(){
			fileApi.clear();
			fileApi.reloadInfo();
			if(!FILE_INFO.fileUrl) return false;
			var loading = Tips.loadingMask(false,false,0.5);
			$.ajax({
				type:'GET',
				dataType:'binary',
				// responseType: 'blob',//text arraybuffer binary
				url:FILE_INFO.fileUrl,
				processDownload:function(percent){loading.title(Math.round(percent*100)+'%');},
				error:function(){console.error(arguments);loading.close();},
				success:function(data){
					loading.close();
					if(!data) return
					fileApi.setContent(data);
				}
			});
		},	
		save:function(content,callback){
			if(!FILE_INFO.canWrite && FILE_INFO.fileUrl){return;}
			if(FILE_INFO.savePath){
				return kodApi.fileSave(FILE_INFO.savePath,content,callback);
			}
			fileApi.saveCreate(false,content,callback);
		},
		saveCreate:function(fileName,content,callback){
			var fileName = fileName || FILE_INFO.fileName || LNG['explorer.newFile']+'.edraw';
			kodApi.fileCreate(fileName,content,function(data){
				FILE_INFO.fileUrl  = '---';
				FILE_INFO.fileName = data.name,
				FILE_INFO.savePath = data.path,
				FILE_INFO.canWrite = true;
				fileApi.reloadInfo();
				callback && callback();
		   });
		},
		
		bindEvent:function($main){
			$main = $main || $('body');
			$main.bind('keydown',function(e){
				var isCtrl = e.ctrlKey || e.metaKey;
				if(isCtrl && e.key == 's'){fileApi.fileSave();return stopPP(e);}
				if(isCtrl && e.key == 'o'){fileApi.open();return stopPP(e);}
			});
			$main.delegate('[kod-action]','click',function(){
				var action = $(this).attr('kod-action');
				switch(action){
					case 'file-save':fileApi.fileSave();break;
					case 'file-open':fileApi.open();break;
					case 'file-select':
						var filePath = $(this).attr('data-path');
						filePath && kodApi.folderView(filePath);
						break;
					default:break;
				}
			});
		},
		fileSave:function(callback){
			var $saveBtn = $('[kod-action="file-save"]');
			$saveBtn.addClass('disabled');
			fileApi.getContent(function(content){
				fileApi.save(content,function(data){
					$saveBtn.removeClass('disabled');
					callback && callback(data);
				});
			});
		},
		fileExt:function(thePath) {
			thePath = thePath || FILE_INFO.fileName || 'file.'+fileApi.ext;
			var ext  = thePath.substr(thePath.lastIndexOf(".") + 1) || '';
			return ext.toLowerCase();
		},

		// 实现
		clear:function(){},
		reloadInfo:function(){},
		getContent:function(callback){},
		setContent:function(data){},
	};
	
	// var link = "https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.min.js";
	// requireAsync(link,function(){eruda.init();});
	var $app = $('#root');
	fileApi.bindEvent($app);
	fileApi.clear = function(){
		excalidrawAPI.updateScene({elements:[]});
		$(".welcome-screen-center").hide();
	};
	fileApi.setContent = function(blob){
		if(!blob || blob.size <= 2){
			return fileApi.clear();
		}
		blob.text().then(function(text){
			var json = jsonDecode(text);if(!json){return;}
			json.scrollToContent = true;
			if(json && json.appState){delete json.appState.gridSize;}
			
			fileApi.reloadInfo();
			excalidrawAPI.addFiles(json.files);
			excalidrawAPI.updateScene(json);
			excalidrawAPI.history.clear();
			// storeAppstatus(_.pick(viewStatusStore,'scrollX,scrollY,zoom'.split(',')));console.log(123,viewStatusStore,json);
			// excalidrawAPI.scrollToContent(excalidrawAPI.getSceneElements(),{fitToContent:true,fitToViewport:0});
		});
	};
	
	fileApi.getContent = function(callback){
		var api   = excalidrawAPI, state = api.getAppState();
		var opts  = {elements:api.getSceneElements(),files:api.getFiles()};
		ExcalidrawLib.exportToCanvas(opts).then(function(canvas){
			var image 	 = canvas.toDataURL('image/jpeg',0.5).replace('data:image/jpeg;base64,','');
			var appState = {gridSize:state.gridSize,viewBackgroundColor:state.viewBackgroundColor};
			var json = {type:"excalidraw",elements:api.getSceneElements(),appState:appState,files:api.getFiles()};
			var content  = jsonEncode(json);
			content = '{"_imageLength":"'+image.length+'","_image":"'+image+'",'+content.substr(1);
			callback(content);
		});
	},
	fileApi.reloadInfo = function(){
		var fileName = FILE_INFO.fileName || LNG['explorer.newFile']+'.edraw';
		var readOnly = !FILE_INFO.canWrite && FILE_INFO.fileUrl;
		if(!FILE_INFO.savePath && !FILE_INFO.fileUrl){fileName = "*" + fileName;}
		
		document.title = fileName + ' - '+appTitle;
		$('body').setClass('kod-read-only',readOnly);
		$('.kod-file-name').html(htmlEncode(fileName));
		$('[kod-action=file-open]').attr('data-path',FILE_INFO.savePath||"");
		storeAppstatus({name:fileName,viewModeEnabled:!!readOnly});
	};
	
	// https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils
	var initView = function(){
		ExcalidrawLib.FONT_FAMILY['Virgil'] = 9;
		ExcalidrawLib.FONT_FAMILY[fontFamily] = 1;
		fileApi.loadFile();
		
		// 外部素材库点击url重置;
		$app.delegate('.library-menu-browse-button','mousedown touchstart',function(e){
			var urlInfo	= $.parseUrl($(this).attr('href'));
			var param 	= _.extend(urlInfo.params || {},{referrer:$.parseUrl().url});
			var args 	= _.map(param,function(v,k){return k+'='+urlEncode(v);}).join('&');
			var urlNow  = urlInfo.urlPath+'?'+args;
			$(this).attr('href',urlNow);
		});		
		$app.delegate(".welcome-screen-menu button:eq(0)",'mousedown',function(e){
			fileApi.open();stopPP(e);
		});
		var addMenuAuto = function(){
			var $export = $app.find('[data-testid="image-export-button"]');
			var html = `
			<div class="dropdown-menu-kod">
			<button type="button" class="dropdown-menu-item dropdown-menu-item-base" kod-action="file-save">
				<div class="dropdown-menu-item__icon"></div>
				<div class="dropdown-menu-item__text">`+LNG['common.save']+`</div>
				<div class="dropdown-menu-item__shortcut">Cmd+S</div>
			</button>
			<button type="button" class="dropdown-menu-item dropdown-menu-item-base" kod-action="file-open">
				<div class="dropdown-menu-item__icon"></div>
				<div class="dropdown-menu-item__text">`+LNG['common.open']+`</div>
				<div class="dropdown-menu-item__shortcut">Cmd+O</div>
			</button>
			<div class="hr-line"></div>
			</div>`;
			$(".dropdown-menu-kod").remove();
			if(!$export.length){return;}
			if(!FILE_INFO.canWrite && FILE_INFO.fileUrl){return;}
			$(html).insertBefore($export);
		};
		$app.delegate('button[data-testid="main-menu-trigger"]','click',function(e){
			setTimeout(addMenuAuto,0);
		});
	};
	
	var fontFamily = 'Virgil,Chalkboard,HannotateSC-W5,YuppyTC-Regular,FZJingLeiS-R-GB,FZJLJW--GB1-0,DFShaoNvW5,STXingkai,KaiTi,fangsong';
	var langMap = {
		'en':'en','zh-CN':'zh-CN','zh-TW':'zh-TW',
		'ar':'ar-SA','de':'de-DE','es':'es-ES','fr':'fr-FR','hi':'hi-IN','id':'id-ID',	
		'it':'it-IT','pl':'pl-PL','pt':'pt-PT','ru':'ru-RU','tr':'tr-TR','uk':'uk-UA',	
	};
	var appOptions = {
		langCode:langMap[appLang] || 'en',// https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/i18n.ts#L14
		autoFocus:true,
		gridModeEnabled:true,
		zenModeEnabled:false,
		viewModeEnabled:false,
		exportWithDarkMode:true,
	};
	if(!FILE_INFO.canWrite && FILE_INFO.fileUrl){
		appOptions.viewModeEnabled = true;
	}

	// 用户配置调整,保存到浏览器;
	var storeAppstatus = function(valueSet){
		if(!window.localStorage || !window.excalidrawAPI){return;}

		var state = excalidrawAPI.getAppState();
		_.extend(state,valueSet);
		excalidrawAPI.updateFrameRendering();
		//localStorage.setItem('excalidraw-state',jsonEncode(state));
	};
	
	// 内容设置前, json中图片设置到 indexDB (暂不使用; 使用默认 excalidrawAPI.addFiles )
	var storeJsonImage = function(json,callback){
		localStorage.setItem('excalidraw',jsonEncode(json.elements));
		if(!_.isEmpty(json.files)){
			var countTotal 	  = _.values(json.files).length;
			var countSuccess  = 0;
			var checkFinished = function(res){
				console.log(123,res);
				countSuccess ++;
				if(countSuccess == countTotal){callback();}
			};
			_.each(json.files,function(v,k){
				dbStore.set(v,k,checkFinished);
			});
		}else{
			callback();
		}
	};
	
	var dbStoreMake = function(dbName,storeName,indexArr){
		var db 	 = false,hasError = false;
		var conn = indexedDB.open(dbName,1);
		conn.onsuccess = function(evt){
			db = evt.target.result;
			taskRun();
		};
		conn.onupgradeneeded = function(evt){
			db = evt.target.result;
			var store = false;
			if(db.objectStoreNames.contains(storeName)){return;}
			if(!indexArr){
				var store = db.createObjectStore(storeName,{autoIncrement:true});
				return;
			}
			_.each(indexArr,function(k,i){
				if(i == 0){store = db.createObjectStore(storeName,{keyPath:k});return;}
				if(store){store.createIndex(k,k,{unique:false});}
			});
		};

		var taskArr = [];
		var actionMap = {get:'get',set:'add',remove:'delete'};
		var taskRun = function(action,args){
			if(action){taskArr.push({action:action,args:args});}
			if(!db){return;}
			_.each(taskArr,function(item){
				taskRunItem(item.action,item.args);
			});
			taskArr = [];
		};
		var taskRunItem = function(action,args){
			var actionRun = actionMap[action];
			var showOut = function(code,data){
				var callback  = args[args.length - 1] || function(){};
				callback({code:code,action:action,data:data || ''});
			}
			if(hasError){return showOut(false,hasError);}
			if(action == 'clear'){
				db.deleteObjectStore(storeName);
				return showOut(true,'');
			}
			if(!actionRun){return showOut(false,'method not exists;');}
			var transaction = false;
			try{
				transaction = db.transaction(storeName,"readwrite");
			}catch(error){
				hasError = error;
				return showOut(false,hasError);
			}
			var store 	= transaction.objectStore(storeName);
			var request = store[actionRun].apply(store,args.slice(0,-1));
			request.onsuccess = function(){
				showOut(true,request.result);
			};
			request.onerror = function(e){
				e.preventDefault();
    			e.stopPropagation();
				showOut(false,request.error);
			};
		}
		var taskRunMake = function(action){
			return function(){
				taskRun(action,_.toArray(arguments));
			};
		};
		return {
			conn:conn,
			getDB:function(){return db;},
			get:taskRunMake('get'),			// k,callback
			set:taskRunMake('set'),			// v,callback
			remove:taskRunMake('remove'),	// k,callback
		};
	};
	// var dbStore = dbStoreMake('files-db3','files-store222',['id']);
	// dbStore.set({id:'s10165',name:'xxx'},console.log);dbStore.get('s101',console.log);
	// var dbStore = dbStoreMake('files-db','files-store');
	
	
	// 不同文件间隔离(编辑会自动保存,自动同步到不同浏览器标签); key替换追加文件路径;
	var storeReset = function(){
		var resetMethod = ['setItem','getItem','removeItem'];
		var changeKey = 'excalidraw,excalidraw-state,version-dataState,version-files'.split(',');
		var filePath = urlDecode(_.trim(_.get($.parseUrl(),'params.path',''),'/'));
		var resetKey = function(k){
			if(!_.includes(changeKey,k)){return k;}
			return k+'-'+filePath;
		};
		
		// 首次存储界面配置时,默认值覆盖处理;
		var resetSaveStatus = function(args){
			if(!_.startsWith(args[0],'excalidraw-state')){return;}
			if(localStorage.getItem(args[0])){return;}
			var saveFirst = jsonDecode(args[1]);
			if(!saveFirst){return;}
			
			_.extend(saveFirst,appOptions);
			args[1] = jsonEncode(saveFirst);
			setTimeout(function(){excalidrawAPI.updateFrameRendering();},5);
		};
		_.each(resetMethod,function(method){
			var _method = localStorage[method];
			localStorage[method] = function(){
				arguments[0] = resetKey(arguments[0]);
				if(method == 'setItem'){resetSaveStatus(arguments);}
				return _method.apply(localStorage,arguments);
			};
		});
		localStorage.setItem('i18nextLng',appOptions.langCode);
	};storeReset();
	var viewStatusStore = jsonDecode(localStorage.getItem('excalidraw-state'));
	
	var _appendChild = document.head.appendChild;
	var host = location.protocol + "//" + location.host;
	document.head.appendChild = function(node){
		var href = node ? node.href:'';
		if(href && href.indexOf(host+'/assets/') === 0){
			node.href = href.replace(host+'/assets/',EXCALIDRAW_ASSET_PATH[0]+'assets/');
			//console.log('appendChild:',node,node.href);
		}
		return _appendChild.apply(document.head,arguments);
	};
	
	// 加载初始化处理;配置响应;
	var hasLoad = false;
	window._pageLoad = function(){
		if(!window.excalidrawAPI || hasLoad){return;}
		initView();hasLoad = true;
	};
})();