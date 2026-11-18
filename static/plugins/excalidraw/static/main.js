kodReady.push(function(){
	var iconFile = '{{pluginHost}}static/images/icon.svg';
	var iconApp  = iconFile;
	Events.bind('explorer.kodApp.before',function(appList){
		appList.push({
			name:'{{package.id}}',
			title:'{{package.name}}',
			ext:'{{config.fileExt}}',
			icon:iconFile,
			sort:"{{config.fileSort}}",
			appFileEdit:true,appFileView:true,
			callback:function(){
				core.openFile('{{pluginApi}}',"{{config.openWith}}",_.toArray(arguments));
			}
		});
	});
	Events.bind('explorer.lightApp.load',function(listData){
		listData['{{package.id}}'] = {
			name:"{{package.name}}",
			desc:"{{package.description}}",
			category:"{{package.category}}",
			appUrl:'{{pluginApi}}',
			openWith:"{{config.openWith}}",
			icon:iconFile
		}
	});

		
	// 新建处理;
	Events.bind('rightMenu.newFileAdd',function(menuList){
		menuList.push({type:'edraw',name:'{{package.name}}',createOpen:1,appName:'{{package.id}}'});
	});
	Router.mapIframe({page:'{{package.id}}',title:'{{package.name}}',url:'{{pluginApi}}',ignoreLogin:1});
	Events.bind('main.menu.loadBefore',function(listData){ //添加到左侧菜单栏
		listData['{{package.id}}'] = {
			name:"{{package.menu}}",
			url:'{{pluginApi}}',
			target:'{{config.openWith}}',
			subMenu:'{{config.menuSubMenu}}',
			menuAdd:'{{config.menuAdd}}',
			icon:iconApp
			// icon:'ri-organization-chart bg-yellow-6'
		}
	});
	
	Events.bind('aceEditor.fileOpenModeInit',function(modeList){
		modeList.json = modeList.json ? modeList.json + ','+'{{config.fileExt}}':'{{config.fileExt}}';
	});
	
	var memuBarIcon = '.menuBar .menu-topbar .menu-item[link-href="excalidraw"]{}'
	$.addStyle(memuBarIcon+".x-item-icon.x-excalidraw,.x-item-icon.x-edraw,.x-item-icon.x-excalidrawlib{background-image:url("+iconFile+");background-size:85%;}");
});
