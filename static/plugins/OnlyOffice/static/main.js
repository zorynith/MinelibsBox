kodReady.push(function(){
	Events.bind('explorer.kodApp.before',function(appList){
		appList.push({
			name:'{{package.id}}',
			title:'{{package.name}}',
			ext:"{{config.fileExt}}",
			sort:"{{config.fileSort}}",
			icon:'{{pluginHost}}static/images/icon.png',
			appFileEdit:true,appFileView:true,
			callback:function(){
				var save  = $.getUrlParam('saveCallback');
				var param = save ? "&saveCallback="+save: '';		
				core.openFile('{{pluginApi}}',"{{config.openWith}}",_.toArray(arguments),param);
			}
		});
	});
	
	
});
