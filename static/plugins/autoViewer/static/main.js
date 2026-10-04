kodReady.push(function(){
	var iconFile = '{{pluginHost}}static/images/icon.svg';
	var extAllow = '{{config.fileExt}}';
	Events.bind('explorer.kodApp.before',function(appList){
		appList.push({
			name:'autoViewer',
			title:'{{LNG[\'autoViewer.meta.name\']}}',
			ext:extAllow,
			icon:iconFile,
			sort:"{{config.fileSort}}",
			appFileEdit:true,appFileView:true,
			callback:function(){
				core.openFile('{{pluginApi}}',"{{config.openWith}}",_.toArray(arguments));
			}
		});
	});

	var styleIcon = [],styleImage = [];
	_.each(extAllow.split(','),function(ext){
		ext = _.trim(ext);if(!ext || ext == '|'){return;}
		styleIcon.push('.x-item-icon.x-'+ext);
		styleIcon.push('.x-item-icon.small.x-'+ext);
		styleImage.push('.path-ico.name-'+ext+' .picture.ico img');
	});
	$.addStyle(
		styleIcon.join(',')+"{background-image:url("+iconFile+");background-size:85%;}"+
		styleImage.join(',')+"{background:none !important;box-shadow:none !important;}"
	);

	var styleCad = [
		'.path-ico.name-dxf .picture.ico img',
		'.path-ico.name-dwg .picture.ico img',
		'.path-ico.name-dxfb .picture.ico img',
	];// 深色模式,cad缩略图为浅黑半透明;
	var styleCadDark = _.map(styleCad,function(i){return '.dark-mode '+i;});
	$.addStyle(
		styleCad.join(',')+'{background-color:#000000e0 !important;box-shadow:1px 1px 5px #00000033 !important;filter:brightness(5.1) contrast(1.04) saturate(5.1);}'+
		styleCadDark.join(',')+'{background-color:#000000d0 !important;box-shadow:1px 1px 5px #00000033 !important;}'
	);
});
