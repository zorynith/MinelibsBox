kodReady.push(function(){
	Events.bind('explorer.kodApp.before',function(appList){
		appList.push({
			name:'{{package.id}}',
			title:'{{package.name}}',
			ext:"{{config.fileExt}}",
			sort:"{{config.fileSort}}",
			icon:'{{pluginHost}}static/images/icon.svg',
			callback:function(path,ext,name){
				var file = {
					url:core.path2url(path,true),
					name:name,
					path:path,
					ext:ext,
					autoplay:"{{config.autoplay}}",
					cdn:"{{config.cdn}}"
				};
				var appStatic = "{{pluginHost}}static/";
				requireAsync(appStatic+'page.js'+"?v={{package.version}}",function(play){
					play(appStatic,file);
				});
			}
		});
	});
});
