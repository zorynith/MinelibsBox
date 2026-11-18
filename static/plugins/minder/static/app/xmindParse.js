(function(){
	// https://github.com/wanglin2/mind-map/blob/main/simple-mind-map/src/parse/xmind.js
	var parseXmindFile = function(file){
		return new Promise(function(resolve,reject){
			JSZip.loadAsync(file).then(function(zip){
				try{
				var jsonFile = zip.files['content.json']
				var xmlFile  = zip.files['content.xml'] || zip.files['/content.xml'];
				var loaded   = function(nodes){
					if(nodes && nodes.data){
						nodes.data.borderWidth = 1;
						nodes.data.lineWidth = 1;
					}
					nodes ? resolve(nodes):reject(new Error('解析失败'));;
				};
				if(jsonFile) {
					jsonFile.async('string').then(function(content){
						xmind.transformXmind(content,zip.files).then(function(nodes){
							nodeExtend(nodes,JSON.parse(content)[0]);
							loaded(nodes);
						});
					});
				}else if(xmlFile){
					xmlFile.async('string').then(function(content){
						var json  = xml2json(content);
						var nodes = xmind.transformOldXmind(json);
						// console.log(234,nodes,JSON.parse(json));// nodeExtend(nodes,json,true);
						loaded(nodes);
					});
				}
				}catch (error){reject(error);}
			},function(e){
				reject(e)
			});
		});
	};

	var nodeExtend = function(nodes,tree,level){
		level = level || 0;
		var nodeData = nodes.data,nodeChild = nodes.children;
		var treeJson = level == 0 ? tree.rootTopic : tree;
		parseNode(level,nodeData,treeJson,tree,nodes);
		_.each(_.get(treeJson,'children.attached'),function(treeNow,i){
			nodeExtend(nodeChild[i],treeNow,level+1);
		});
	};
	
	var nodeStyle = {
		color:'',			// 文字颜色
		fontSize:'',		// 字体大小
		fontFamily:'',		// 字体
		fontWeight:'',		// bold 加粗;
		fontStyle:'',		// italic 斜体;
		textDecoration:'',	// overline,line-through,underline  // 上划线,中划线,下划线;
		
		borderColor:'',		// 边框颜色
		borderWidth:'',		// 边框线粗细(0~6)
		borderRadius:'',	// 边框圆角(0~10)
		borderDasharray:'',	// 边框线条样式;none=实线; "5,5",... 不同类型虚线;
		
		lineColor:'',		// 子节点连线颜色;
		lineWidth:'',		// 子节点连线粗细
		lineDasharray:'',	// 子节点连线样式;none=实线; "5,5",... 不同类型虚线;

		paddingX:'',		// 节点x边距
		paddingY:'',		// 节点y边距
		fillColor:'',		// 填充颜色;
		shape:'',			
		// 形状;rectangle/diamond/parallelogram/roundedRectangle/octagonalRectangle/outerTriangularRectangle/innerTriangularRectangle/ellipse/circle
		// 矩形/菱形/平行四边形/圆角矩形/八角矩形/外三角矩形/内三角矩形/椭圆/圆形
	};
	var mapKey = {
		'fo:color':'color',
		"fo:font-family": "fontFamily",
		"fo:font-size":{key:"fontSize",action:'int'},
		"fo:font-weight": "fontWeight",

		'line-color':'lineColor',
		'line-width':{key:"lineWidth",action:'int'},
		//"line-class": "org.xmind.branchConnection.curve",
		
		'svg:fill':'fillColor',		
		"border-line-color": "borderColor",
		"border-line-width": {key:"borderWidth",action:'int'},
		
		"shape-class": {key:'shape',values:{
			"org.xmind.topicShape.rect":'rectangle',
			"org.xmind.topicShape.callout.ellipse":'ellipse',
			'org.xmind.topicShape.ellipse':'ellipse',
			'org.xmind.topicShape.roundedRect':'roundedRectangle',
		}},
	};
	
	var styleDefault = {mainTopic:{},summaryTopic:{},centralTopic:{}};
	var parseNode = function(level,nodeData,treeJson,tree,nodes){
		if(treeJson.id){nodeData.uid = treeJson.id;}
		if(level == 0 && tree && tree.theme){
			styleDefault = {mainTopic:{},summaryTopic:{},centralTopic:{}};
			_.each(styleDefault,function(v,k){
				parseSytle(tree.theme[k],v);
			});
		}
		if(level == 0){_.extend(nodeData,styleDefault.centralTopic);}
		if(level == 1){_.extend(nodeData,styleDefault.mainTopic);}
		parseSytle(treeJson.style,nodeData);
		if(level == 0){
			if(!nodeData.lineWidth){nodeData.lineWidth = 1;}
			delete nodeData.lineColor;
			xmind._data = {tree:tree,nodes:nodes};
		}
		
		parseSummaries(nodeData,treeJson);
		// console.log(123123,level,tree,nodes);
		var _text = nodeData.text;nodeData.richText = true;
		nodeData.text = _text.replace(/\n/g,'<br/>');
		if(nodeData.text != _text){
			var style = "text-align:center;"+(nodeData.color ? 'color:'+nodeData.color+';':'');
			nodeData.text = '<p><span style="'+style+'">'+nodeData.text+"</p></p>";
		}
	};

	var parseSytle = function(style,node){
		if(!style || !style.properties){return;}
		var styles = style.properties;
		_.each(mapKey,function(key,keyFrom){
			var value = styles[keyFrom];
			if(!value){return;}
			if(typeof(key) == 'object'){
				var _keyMap = key;key = _keyMap.key;
				if(_keyMap.values){value = _keyMap.values[value];}
				if(_keyMap.action == 'int'){value = parseInt(value);}
			}
			node[key] = value;
		});
		if(node.borderColor && node.borderWidth === undefined){node.borderWidth = 1;}
	}
	
	// 概览处理(当前仅支持节点设置总概览)
	var parseSummaries = function(nodeData,treeJson){
		if(!treeJson.summaries || treeJson.summaries.length > 1){return;}
		var info = treeJson.summaries[0];
		var node = (treeJson.children && treeJson.children.summary && treeJson.children.summary[0]) || false;
		if(!info || !node){return;}
		nodeData.generalization = {text:node.title,expand:true,range:info.range,lineWidth:1,borderWidth:1};
		parseSytle(node.style,nodeData.generalization);
	};
	
	
	window.xmind = false;
	window.kodXmindParse = function(){
		// return;
		xmind = mindMap.doExportXMind.getXmind();
		xmind.parseXmindFile = parseXmindFile;
	};	
})();