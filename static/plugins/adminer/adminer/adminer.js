(function(){
	$(window).ready(function(){
		var $main = $('body');
		$('<div class="toggle-menu"></div>').appendTo($main);
		if($(window).width() < 769){
			$main.addClass('app-page-small');
			$main.addClass('menu-hide');
		}
		$('.toggle-menu').bind('click',function(){
			$main.toggleClass('menu-hide');
		});
		keepscrollTop();
	});
	
	var keepscrollTop = function(isSave){
		var $scroll = $("#tables"), key = 'kodbox:adminer-table-top';
		var table   = _.get($.parseUrl(),'params.db','');
		var option  = jsonDecode(localStorage.getItem(key)) || {};
		if(!_.isObject(option)){option = {};}
		if(isSave){
			option[table] = $scroll.scrollTop();
			if(!option[table]){delete option[table];}
			localStorage.setItem(key,jsonEncode(option));
		}else{
			$scroll.scrollTop(parseInt(option[table]) || 0);
		}
	};
	$(window).bind('beforeunload',function(e){
		keepscrollTop(true);
	});
})();