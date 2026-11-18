(function(){
	if($.hasKey('plugin.onlyoffice.event')) return;//只有首次处理,避免重复调用
	var openWindow = function(url,title,width,height){
		title  = title?title:LNG['common.tips'];
		width  = width?width:'80%';
		height = height?height:'70%';
		if($.isWap){
			width = "100%";height = "100%";
		}
		var dialog = $.dialog.open(url,{
			ico:"",title:title,
			fixed:true,resize:true,
			width:width,height:height,
			className: title == 'log' ? 'dialog-no-title' : ''
		});
		return dialog;
	};
	$('body').delegate('.check-onlyoffice-server','click',function(){
		var $dialog = $(this).parents('.aui-dialog');
        $dialog.find('[name=pluginSaveKeepOpen]').val(1);
        $dialog.find('.aui-footer .aui-state-highlight').click();
		setTimeout(function(){
			$dialog.find('[name=pluginSaveKeepOpen]').val(0);
			openWindow(G.kod.appApi + 'plugin/onlyoffice/check'); 
		},200);
	});
	$('body').delegate('.check-onlyoffice-help','click',function(){
		if(_.get(G,'kod.systemOS') == 'linux'){
			window.open('https://docs.kodcloud.com/setup/office/');
		}else{
			window.open('https://docs.kodcloud.com/setup/office_win/');
		}
	});

	$('body').delegate('.view-log','click',function(){
		var timeShow = dateFormat(time(),"20y_m_d");
		var file = "./data/temp/log/onlyoffice/"+timeShow+"__log.php";
		var param = "dataArr="+jsonEncode([{"type":"file","path":file}]);
			param += '&CSRF_TOKEN='+Cookie.get('CSRF_TOKEN');
		$.ajax({
			url:G.kod.appApi + 'explorer/index/pathInfo',
			type:'POST',
			dataType:'json',
			data:param,
			success: function(result){
				if(! result.code){
					var msg = G.lang == 'zh-CN' ? '今日暂无日志！' : 'No log today!';
					Tips.tips(msg, 'warning');
					// Tips.tips(LNG['common.file']+LNG['common.notExists'],false);
				}else{
					openWindow("./#fileView&path="+result.data.path, 'log');
				}
			}
		});
	});	
})();