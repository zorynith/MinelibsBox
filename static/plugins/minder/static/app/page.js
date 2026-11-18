(function(){
	var fileOpenTitle = LNG['explorer.selectFile'] || "选择文件...";
	var fileApi = {
		ext:'smm',allowExt:'smm,mind,km,xmind',
		open:function(){
			kodApi.fileSelect({
				title:fileOpenTitle,
				allowExt:fileApi.allowExt,
				callback:function(result){  // 回调地址;
					if(FILE_INFO.fileUrl){
						var param = '&path='+urlEncode(result.path)+'&name='+urlEncode(result.name);
						//return window.open(kodSdkConfig.pluginApi + param);
					}
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
			var fileName = fileName || FILE_INFO.fileName || '新建文件.smm';
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
					fileChanged();
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
	
	fileApi.bindEvent();
	fileApi.clear = function(){
		$('body').attr('tabindex','1').focus();
		mindMap.command.clearHistory();		
	};
	fileApi.setContent = function(blob){
		if(!blob || blob.size <= 2){return setData(nodeDataDefault);}
		blob.text().then(function(text){
			if(text.substr(0,2) == 'PK'){
				var xmindParse = mindMap.doExportXMind.getXmind();
				return xmindParse.parseXmindFile(blob).then(function(data){
					setData(data);
				},function(e){
					Tips.tips(LNG['minder.parseError']+";"+(e.message || ''),'error',3000);
				});
			}
			if(text.slice(0,1) != '{'){
				Tips.tips(LNG['minder.parseError'],'warning',3000);
				return setData(nodeDataDefault);
			}
			setData(jsonDecode(text));
		});
	};
	
	fileApi.getContent = function(callback){
		if(fileApi.fileExt() == 'xmind'){ // xmind; zip压缩;
			// fileApi.saveCreate;			
			return mindMap.doExportXMind.xmind(mindMap.getData(),'').then(function(data){
				// zip文件结尾直接追加svg图片 image+image.length.pad(20-11,'_')+'-PEND-MIND-'
				var filePend   = '-PEND-MIND-'; // zip文件结尾标识; 共20位;长度数字+填充下划线+标识;
				var svgFile    = getFileSvg();
				var appendStr  = svgFile+(svgFile.length + '').padEnd(20 - filePend.length,'_')+filePend; //
				var blobAppend = new Blob([appendStr],{type:"text/plain"});
				var blobNew = new Blob([data,blobAppend], {type:data.type});
				callback(blobNew);
			});
		}
		var content  = jsonEncode(mindMap.getData(true));
		var svgFile  = getFileSvg();
		content = '{"_imageLength":"'+svgFile.length+'","_image":"'+svgFile+'",'+content.substr(1);
		callback(content);
	},
	
	fileApi.reloadInfo = function(){
		var fileName = FILE_INFO.fileName || LNG['explorer.newFile']+'.smm';
		if(!FILE_INFO.savePath && !FILE_INFO.fileUrl){fileName = "*" + fileName;}
		if(!FILE_INFO.canWrite && FILE_INFO.fileUrl){
			$('body').addClass('kod-read-only');
			mindMap.setMode('readonly');
		}else{
			$('body').removeClass('kod-read-only');
			mindMap.setMode('write');
		}

		document.title = fileName + ' - '+appTitle;
		$('.kod-file-name').html(htmlEncode(fileName));
		$('[kod-action=file-open]').attr('data-path',FILE_INFO.savePath||"");
	};
	
	var nodeDataDefault = {
		root: {data:{text:LNG['minder.nodeName']},children: [
			{data:{text:LNG['minder.nodeSubName'] + " 1"},children:[]},
			{data:{text:LNG['minder.nodeSubName'] + " 2"},children:[]},
			{data:{text:LNG['minder.nodeSubName'] + " 3"},children:[]},
			{data:{text:LNG['minder.nodeSubName'] + " 4"},children:[]},
		]},
		theme: {template:"classic2",config: {}},
		layout: "mindMap", //mindMap,logicalStructure
	};
		
	// 设置文件内容; 当高宽小于屏幕*1.5时自适应画布;
	var setData = function(fileData){
		$('.mindMapContainer').css({opacity:0.01});
		setTimeout(function(){
			$('.mindMapContainer').css({opacity:''}).hide().fadeIn(200);
		},100);
		var autoFit = function(){
			var viewSize = mindMap.el.getBoundingClientRect();
			var drawSize = mindMap.draw.rbox();
			if( drawSize.width  <= viewSize.width * 1.5 && 
				drawSize.height <= viewSize.height * 1.5 ){
				mindMap.view.fit();
			}
		};
		fileChanged();
		window.$bus.$emit('setData',fileData);
		window.$bus.$once('node_tree_render_end',autoFit);
	};
	
	var getFileSvg = function(){
		var svgData  = mindMap.getSvgData({exportPaddingX:10,exportPaddingX:10});
		svgData.svg.css('background-color',mindMap.themeConfig.backgroundColor || '#fff');
		var svgStyle = '<style>*{margin:0;padding:0;box-sizing:border-box;}</style>';
		return base64Encode(svgData.svg.svg().replace('</foreignObject>',svgStyle+'</foreignObject>'));
	};

	var initView = function(){
		var $toolbar = $('.toolbarContainer .toolbar');
		var btnRemove = '.icondakai,.iconxinjian,.iconwenjian1,.iconlingcunwei'.split(',');
		_.each(btnRemove,function(icon){// 按钮移出; 目录/新建/打开/另存为
			var $icon = $toolbar.find('.toolbarBtn > .icon'+icon);
			$icon.parent().remove();
		});
		
		var btnHtml = `
		<div class="toolbarBlock"><div class="toolbarNodeBtnList">
			<div class="el-tooltip toolbarBtn" tabindex="0" kod-action="file-open">
				<span class="icon font-icon ri-file-line-2"></span>
				<span class="text">`+LNG['common.open']+`</span>
			</div>
			<div class="el-tooltip toolbarBtn" tabindex="0" kod-action="file-save">
				<span class="icon font-icon ri-save-fill-3"></span>
				<span class="text">`+LNG['common.save']+`</span>
			</div>
		</div></div>`;
		$(btnHtml).prependTo($toolbar);
		

		$(".fullscreenContainer .item.iconquanping").remove();
		$(".navigatorContainer .item:last").remove();		
		var openPath = '<span kod-action="file-open" class="font-icon ri-folder-line-3"></span>';
		$("<div class='kod-file'><span class='kod-file-name'></span>"+openPath+"</div>").appendTo('.container');

		fileApi.loadFile();
		setTimeout(function(){
			if(!FILE_INFO.fileUrl){setData(nodeDataDefault);}
			kodIconSearchInit();
			$(".vip").removeClass('vip');
		},0);
		
		var _setItem = localStorage.setItem;
		localStorage.setItem = function(key,val){
			if(key == 'VIP_USAGE_TIP'){return _setItem.apply(localStorage,[key,'']);}
			_setItem.apply(localStorage,arguments);
		};
		
		var $settingPanel = $(".sidebarContainer").last();
		$settingPanel.attr('panel-type','view-config');
		$settingPanel.find(".row:eq(0)").hide();
		$settingPanel.find(".row:eq(10)").hide();

		// 保持焦点;快捷键响应;
		var keepFocus = function(){
			if(!$(':focus').length){$('body').focus();}
		}
		$('body').bind('mouseup',keepFocus);
		mindMap.on("node_mouseup",function(e){
			keepFocus();
			$('body').trigger('clickEvent');// 阻止了冒泡,需要手动传递;
		});
	};
	
	// 图片打开修复(图片为 smm_img_key_前缀时); 导出xmind,图片丢失问题处理;
	var imageOpenFix = function(){
		var _setAttribute = HTMLImageElement.prototype.setAttribute;
		Object.defineProperty(HTMLImageElement.prototype,'src',{
			set:function(src){return this.setAttribute('src',src);}
		});
		HTMLImageElement.prototype.setAttribute = function(k,v){
			if(k == 'src' || k == 'data-original-url'){
				var imageMap = _.get(mindMap,'renderer.renderTree.data.imgMap');
				if(imageMap && imageMap[v]){arguments[1] = imageMap[v];}
				// console.log('image-src:',this,k,v,arguments);
			}
			_setAttribute.apply(this,arguments);
		};
	};
	
	// 是否有未保存内容;
	var fileContentLast = false,fileContentJson = false;
	var fileChanged = function(){
		var dataNow = mindMap.getData(true);dataNow.view = null;
		fileContentJson = _.cloneDeep(dataNow);
		fileContentLast = jsonEncode(dataNow);
	};
	var fileHasChange = function(){
		if(!FILE_INFO.canWrite && FILE_INFO.fileUrl){return false;}
		var dataNow = mindMap.getData(true);dataNow.view = null;
		return fileContentLast != jsonEncode(dataNow);
	};

	var initMinder = function(){
		mindMap.keyCommand.removeShortcut('Control+s');		
		$('.mindMapContainer').css({opacity:0.01});		
		$(window).bind("beforeunload",function(e){
			var msg = fileHasChange() ? LNG['minder.closeTips']  : undefined;
			if(msg && e && e.originalEvent){e.originalEvent._returnValue = msg;}
			return msg;
		});

		var viewResize = function(){
			if(!mindMap._isLoaded){return;}
			mindMap.renderer.resetLayout();
		}
		viewResize = _.debounce(viewResize,200);
		$(window).bind("resize",viewResize);
		
		setTimeout(function(){ // 移动端工具栏全部显示,左右滚动处理;
			window.innerWidth = 2000;
			window.dispatchEvent(new CustomEvent("resize"));
			setTimeout(function(){window.innerWidth = $(window).innerWidth();}, 400);
		},0);
		// 点击百分百恢复到100%;已经全屏再点击全屏按钮退出全屏;全屏状态变更后界面重绘;
		$('.scaleContainer .scaleInfo').bind('click',function(){
			mindMap.view.fit();
		});
		$(".fullscreenContainer").bind('click',function(){
			if(!document.fullscreenElement ) return;
			document.exitFullscreen && document.exitFullscreen();
			document.mozCancelFullScreen && document.mozCancelFullScreen();
		});
		$(document).bind('webkitfullscreenchange mozfullscreenchange fullscreenchange',viewResize);
		$(window).delegate('.el-tree-node__content','mousedown',function(e){
			if($.targetParent(e,'.nodeEdit,.el-tree-node__expand-icon')) return;
			return stopPP(e); // 不在节点icon上阻止拖拽
		});
		kodXmindParse();
	};

	//初始配置; https://github.com/wanglin2/mind-map/blob/main/simple-mind-map/src/constants/defaultOptions.js
	// https://github.com/wanglin2/mind-map/blob/main/web/src/store.js
	var appLangMap = {'zh-CN':'zh','zh-TW':'zh','en':'en'};
	var viewConfig   = {
		openPerformance:true,					// 开启性能模式
		enableFreeDrag: false,					// 开启节点自由拖拽
		openNodeRichText: true,					// 是否开启节点富文本
		openRealtimeRenderOnNodeTextEdit:true,	// 开启文本编辑实时渲染效果
		isShowScrollbar: false,					// 是否显示滚动条
		alwaysShowExpandBtn:false,				// 是否一直显示展开收起按钮
		enableAutoEnterTextEditWhenKeydown:true,// 键盘输入时自动进入文本编辑
		isUseHandDrawnLikeStyle: false,			// 是否开启手绘风格
		
		// 选择;
		mousewheelAction: 'zoom',				// zoom,move,默认鼠标滚轮动作;
		mousewheelZoomActionReverse:true,		// 鼠标滚轮缩放
		createNewNodeBehavior:'default',		// default,notActive,activeOnly;
		tagPosition:'right',					// right,bottom;标签位置	
		
		useLeftKeySelectionRightKeyDrag: false,	// 左键选择右键拖拽;or反向
	};var storeConfigKeys = _.keys(viewConfig);
	var mindOptions  = {
		lang:appLangMap[appLang] || 'en',
		data:{
			//root: {data:{text:"NODE"},children: []},
			theme: {template:"classic2",config: {}},
			layout: "mindMap", //mindMap,logicalStructure
			config: {},
			view: null,
		},
		localConfig:_.extend({
			fit:true,			// 初始自适应画布
			isZenMode: false, 	// 是否是禅模式
			isUseMomentum: true,// 是否开启动量效果
			enableDblclickBackToRootNode:true,
			richTextEditFakeInPlace:true,
			defaultInsertSecondLevelNodeText:LNG['minder.nodeName'],
			defaultInsertBelowSecondLevelNodeText:LNG['minder.nodeSubName'],
			enableAi: false,
		},viewConfig),
		supportHandDrawnLikeStyle: true, // 是否支持设置手绘风格
	};
	_.each(storeConfigKeys,function(key){
		if(!window.localStorage){return;}
		var val = localStorage.getItem('minder.'+key);
		if(val === 'false'){val = false;}
		if(val === 'true'){val = true;}
		if(val !== null){mindOptions.localConfig[key] = val;}
	});
	
	window.takeOverAppMethods = {
		getMindMapData:function(){return mindOptions.data;},
		saveMindMapData:function(data){
			var mindConfig = mindMap.getConfig();
			if(!window.localStorage || !data){return;}
			_.each(storeConfigKeys,function(key){
				if(!mindConfig.hasOwnProperty(key)){return;}
				var val = mindConfig[key];
				if(mindOptions.localConfig[key] === val){return;}
				
				mindOptions.localConfig[key] = val;
				localStorage.setItem('minder.'+key,val);
			});
			// console.error(166,data,mindConfig,_.cloneDeep(mindOptions.localConfig));
		},
		
		getLanguage:function(){return mindOptions.lang;},
		saveLanguage:function(lang){;},
		getLocalConfig:function(){return mindOptions.localConfig;},
		saveLocalConfig:function(config){},
		
		getMindMapConfig:function(){return mindOptions.localConfig;},
		saveMindMapConfig:function(config){},
	};
	window.onload = function(){
		if(!window.takeOverApp) return;
		window.mindMapApp = window.initApp();
		window.$bus.$on('app_inited',function(mindMap){window.mindMap = mindMap;});
	};
	window.$bus.$on('app_inited',function(mindMap){
		window.mindMap = mindMap;
		mindMap.updateConfig(mindOptions.localConfig);
		initMinder();
		initView();
		imageOpenFix();
		setTimeout(function(){
			mindMap._isLoaded = true;
		},800);
	});
})();
