/*! Powered by MbesBox;hash:4fe338aac191ed56ec04 */
(function (s) {
  function t(t) {
    var e;
    var n;
    for (var i = t[0], o = t[1], a = 0, r = []; a < i.length; a++) {
      n = i[a];
      if (Object.prototype.hasOwnProperty.call(l, n) && l[n]) {
        r.push(l[n][0]);
      }
      l[n] = 0;
    }
    for (e in o) {
      if (Object.prototype.hasOwnProperty.call(o, e)) {
        s[e] = o[e];
      }
    }
    for (u && u(t); r.length;) {
      r.shift()();
    }
  }
  var n = {};
  var l = {
    "1": 0
  };
  function c(t) {
    return d.p + "" + ({
      "4": "vendor"
    }[t] || t) + ".js?v=4fe338aa";
  }
  function d(t) {
    var e;
    return (n[t] || (e = n[t] = {
      i: t,
      l: false,
      exports: {}
    }, s[t].call(e.exports, e, e.exports, d), e.l = true, e)).exports;
  }
  d.e = function p(i) {
    var t;
    var o;
    var a;
    var e;
    var r;
    var n = [];
    var s = l[i];
    if (s !== 0) {
      if (s) {
        n.push(s[2]);
      } else {
        t = new Promise(function (t, e) {
          s = l[i] = [t, e];
        });
        n.push(s[2] = t);
        (o = document.createElement("script")).charset = "utf-8";
        o.timeout = 120;
        if (d.nc) {
          o.setAttribute("nonce", d.nc);
        }
        o.src = c(i);
        a = new Error();
        e = function (t) {
          o.onerror = o.onload = null;
          clearTimeout(r);
          var e;
          var n = l[i];
          if (n !== 0) {
            if (n) {
              e = t && (t.type === "load" ? "missing" : t.type);
              t = t && t.target && t.target.src;
              a.message = "Loading chunk " + i + " failed.\n(" + e + ": " + t + ")";
              a.name = "ChunkLoadError";
              a.type = e;
              a.request = t;
              n[1](a);
            }
            l[i] = undefined;
          }
        };
        r = setTimeout(function () {
          e({
            type: "timeout",
            target: o
          });
        }, 120000);
        o.onerror = o.onload = e;
        document.head.appendChild(o);
      }
    }
    return Promise.all(n);
  };
  d.m = s;
  d.c = n;
  d.d = function (t, e, n) {
    if (!d.o(t, e)) {
      Object.defineProperty(t, e, {
        enumerable: true,
        get: n
      });
    }
  };
  d.r = function (t) {
    if (typeof Symbol != "undefined" && Symbol.toStringTag) {
      Object.defineProperty(t, Symbol.toStringTag, {
        value: "Module"
      });
    }
    Object.defineProperty(t, "__esModule", {
      value: true
    });
  };
  d.t = function (e, t) {
    if (t & 1) {
      e = d(e);
    }
    if (t & 8) {
      return e;
    }
    if (t & 4 && typeof e == "object" && e && e.__esModule) {
      return e;
    }
    var n = Object.create(null);
    d.r(n);
    Object.defineProperty(n, "default", {
      enumerable: true,
      value: e
    });
    if (t & 2 && typeof e != "string") {
      for (var i in e) {
        d.d(n, i, function (t) {
          return e[t];
        }.bind(null, i));
      }
    }
    return n;
  };
  d.n = function (t) {
    var e = t && t.__esModule ? function n() {
      return t.default;
    } : function i() {
      return t;
    };
    d.d(e, "a", e);
    return e;
  };
  d.o = function (t, e) {
    return Object.prototype.hasOwnProperty.call(t, e);
  };
  d.p = "";
  d.oe = function (t) {
    console.error(t);
    throw t;
  };
  var e = (i = window.webpackJsonp = window.webpackJsonp || []).push.bind(i);
  i.push = t;
  for (var i = i.slice(), o = 0; o < i.length; o++) {
    t(i[o]);
  }
  var u = e;
  d(d.s = 701);
})({
  "23": function (t, e, n) {
    "use strict";

    Object.defineProperty(e, "__esModule", {
      value: true
    });
    window.Promise ||= Promise;
    var i = "./static/";
    if (window.API_HOST) {
      (o = API_HOST.split("/")).pop();
      i = o.join("/") + "/static/";
    }
    window.API_URL = function (t, e) {
      var n = window.API_HOST;
      var i = "&";
      if (e === "" || _.isNull(e) || _.isUndefined(e)) {
        return n + (t || "");
      } else {
        if (n.indexOf("?") == -1) {
          i = "?";
        }
        if (Cookie.accessToken) {
          e += "&accessToken=" + Cookie.accessToken;
        }
        return n + (t || "") + i + (e || "");
      }
    };
    window.API_URL_TRUE = function (t) {
      t = (t = t || window.location.href).replace(API_URL(), "").replace(G.kod.APP_HOST, "").replace("?", "&");
      return G.kod.APP_HOST + "?" + t;
    };
    var o = window.STATIC_PATH || i;
    n.p = o + "app/dist/";
    var a = n.e(4).then(function (t) {
      n(599);
      n(600);
      n(135);
      n(601);
      n(134);
      n(142);
      n(602);
      n(603);
      n(604);
      n(605);
      n(606);
      n(607);
      n(608);
      n(609);
      n(610);
      n(611);
      n(143);
      n(612);
      n(613);
      n(614);
      n(615);
      n(616);
      n(617);
      n(618);
      n(619);
      n(620);
      n(621);
      n(622);
      n(623);
      window.Pinyin = n(624).default;
      n(625);
      n(626);
      n(627);
      n(628);
      n(629);
      n(630);
      n(631);
      n(632);
      n(633);
      n(634);
      n(635);
      n(139);
      n(636);
      n(140);
      n(141);
      n(138);
      n(637);
      n(638);
      n(639);
      n(640);
      n(641);
      n(136);
      n(137);
      n(642);
      window.Backbone.$ = $;
      window.Events = Backbone.Events;
      s();
    }.bind(null, n)).catch(n.oe);
    var r = Date.now();
    var s = function s() {
      var n = seajs.use;
      seajs.use = function () {
        var t = _.toArray(arguments);
        var i = function i(t) {
          var e = _.get(window, "G.kod.version", "");
          var n = _.get(window, "G.kod.build", "");
          if (!(e = _.get(window, "G.kod.ENV_DEV") == 1 ? r : e + "." + n) || _.includes(t, "&v=") || _.includes(t, "?v=") || _.includes(t, "?")) {
            return t;
          } else {
            if (!_.endsWith(t, ".htm") && !_.endsWith(t, ".html") && !_.endsWith(t, ".css") && !_.endsWith(t, ".json") && !_.endsWith(t, ".js")) {
              t += ".js";
            }
            return t + "?v=" + e;
          }
        };
        var e = t[0];
        if (_.isString(e)) {
          t[0] = i(e);
        } else if (_.isArray(e)) {
          t[0] = _.map(e, function (t) {
            return i(t);
          });
        }
        n.apply(seajs, t);
      };
      window._ktime = dateFormat(false, "dhi");
      window.requireAsync = seajs.use;
      window.requirePromise = function (t) {
        var e = $.Deferred();
        seajs.use(t, e.resolve);
        return e;
      };
    };
    (function w() {
      var i;
      if (window.lessENV == "development") {
        i = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (t, e) {
          var n = Array.prototype.slice.call(arguments, 0);
          if (e.match(/\.less$/)) {
            n[1] = e + "?_t=" + r;
          }
          return i.apply(this, n);
        };
      }
    })();
    var l = function l() {
      var t = window.STATIC_PATH_ALL || i;
      requireAsync([t + "style/lib/alifont/iconfont.css", t + "style/lib/font-icon/style.css"]);
    };
    var c = function c() {
      var t = $.parseUrl();
      var e = API_URL("user/view/plugins", "v=" + time());
      if (_.get(t, "params.accessToken")) {
        e += "&accessToken=" + t.params.accessToken;
      }
      if (_.get(t, "params.accessToken") && window.Cookie && !Cookie._hasSet && (Cookie._hasSet = true, Cookie.set("_hasSetCheck", "check"), Cookie.get("_hasSetCheck") != "check")) {
        Cookie.accessToken = t.params.accessToken;
      }
      return requirePromise(e);
    };
    var d = function d(i) {
      Events.trigger("user.optionLoadBefore");
      var t = $.parseUrl();
      var e = API_URL("user/view/options", "v=" + time() + (i ? "&full=1" : ""));
      if (_.get(t, "params.accessToken")) {
        e += "&accessToken=" + t.params.accessToken;
      }
      if (t.hash && t.hash.substr(0, 2) == "s/") {
        e += "&shareID=" + t.hash.substr(2);
      }
      return requirePromise("text!" + e).then(function (t) {
        var e;
        var n;
        if ((t = t && JSON.parse(t)) && t.code && t.data) {
          window.G = _.extend(window.G || {}, t.data);
          n = G.kod.staticPath;
          e = API_URL();
          if (!_.startsWith(n, "http")) {
            n = (n = _.startsWith(n, "/") ? $.parseUrl(e).origin + n : e.substr(0, _.lastIndexOf(e, "/")) + "/" + n).replace("/./", "/");
          }
          window.STATIC_PATH_ALL = window.STATIC_PATH_ALL || G.kod.APP_HOST + "static/";
          window.STATIC_PATH = n;
          window.VENDER_PATH = window.STATIC_PATH + "app/vender/";
          window.API_HOST = G.kod.appApi;
          if (i && t.data._lang) {
            p(t.data._lang);
            delete t.data._lang;
          }
          $.dialog.defaults.path = window.STATIC_PATH + "app/vender/artDialog-icon/";
          requireAsync(window.STATIC_PATH + "style/lib/alifont/iconfont.js");
          l();
          Events.trigger("user.optionLoadAfter");
        }
      });
    };
    var u = function u() {
      return d(true);
    };
    var p = function p(t) {
      window.LNG = _.extend(window.LNG || {}, _.get(t, "list"));
      window.G.lang = _.get(t, "lang", "zh-CN");
      LNG.find = function (n) {
        var i = {};
        _.each(LNG, function (t, e) {
          if (_.includes(t, n)) {
            i[e] = t;
          }
        });
        return i;
      };
      LNG.set = function (t) {
        if (t && _.isObject(t)) {
          _.extend(LNG, t);
        }
      };
      LNG.make = function (t) {
        var e = _.toArray(arguments);
        var n = LNG[t];
        if (!n) {
          return t;
        }
        for (var i = 1; i < e.length; i++) {
          n = n.replace(/(%d|%s)/, e[i]);
        }
        return n;
      };
      LNG.space = "<i class=\"char-space\"></i>";
      LNG.logo = function (t) {
        var e;
        var n;
        var i = window.G.system.options || {};
        var o = i.systemNameType == "image";
        var a = i.systemLogo;
        var r = STATIC_PATH + "images/common/logo.png";
        if (!_.includes(["zh-CN", "zh-TW"], G.lang)) {
          r = STATIC_PATH + "images/common/logo-en.png";
        }
        if (!a || a == "./static/images/common/logo.png") {
          a = r;
        }
        var s = G.kod.companyInfo || false;
        var l = s.logoText || "";
        if (s && s.logoType == "text" && l) {
          return "<span class=\"logo-text\" title=\"" + htmlEncode(htmlEncode(l)) + "\" title-timeout=\"200\"><i class=\"font-icon ri-cloud-fill mr-5\"></i>" + htmlEncode(l) + "</span>";
        } else {
          e = function e(t) {
            return "<img src=\"" + t + "\" onerror=\"this.onerror=null;this.src='" + r + "'\"/>";
          };
          n = function n(t) {
            return "<span class=\"logo-text\">" + htmlEncode(t) + "</span>";
          };
          if (t == "copyright") {
            l = LNG["common.copyright.name"];
            if (o) {
              return e(a);
            } else {
              return n(l);
            }
          } else if (t != "login" || o) {
            return e(a);
          } else {
            return n(i.systemName);
          }
        }
      };
    };
    var f = function f() {
      var t = API_URL("user/view/lang", "v=" + time());
      return requirePromise("text!" + t).then(function (t) {
        if (t) {
          try {
            t = JSON.parse(t);
          } catch (e) {
            return h(t);
          }
          if (t && t.code && t.data) {
            p(t.data);
          }
        }
      });
    };
    var h = function h(t) {
      Tips.close("System error!", false);
      var e = (e = $.dialog.list.xhrErrorDialog) || $.dialog({
        id: "xhrErrorDialog",
        padding: 0,
        width: "55%",
        height: "60%",
        fixed: true,
        resize: true,
        title: "System Error",
        content: ""
      });
      var t = "\n\t\t<div class=\"ajaxError\">\n\t\t<div class=\"content-preview\">\n\t\t<style>\n\t\t.ajaxError{\n\t\t\toverflow:auto;padding:20px 5%;color:#555;font-size:13px;line-height:1.5em;\n\t\t\tfont-family:\"Helvetica\",\"Lantinghei SC\",PingFangSC-light,PingFangTC-light, \"PingFang SC\",Optima-Regular,\"Microsoft Yahei\",\"WenQuanYi Micro Hei\",\"微软雅黑\",\"STXihei\",\"WenQuanYi Micro Hei\",Arial,sans-serif;\n\t\t}\n\t\t.ajaxError #msgbox{margin:0 auto;}\n\t\t.error-tips{padding:5px 0 10px;border-bottom:1px solid #eee;margin-bottom:10px;font-size: 14px;}\n\t\t.content-preview{\n\t\t\tborder: 1px solid #fff1f0;padding:5px 20px 10px 20px;\n\t\t\tbackground: #fff9f9;border-radius:4px;margin-bottom:50px;\n\t\t}\n\t\t</style>\n\t\t<h3 style=\"color:#f04134\" >System Error!</h3>" + htmlSafe(t) + "\n\t\t</div></div>";
      $.iframeHtml(e.$main.find(".aui-content"), t);
    };
    var m = function m() {
      return a.then(function () {
        if (!NProgress.isStarted()) {
          NProgress.start();
        }
        NProgress.set(0.5);
      }).then(c).then(function () {
        NProgress.set(0.6);
      }).then(u).then(function () {
        NProgress.done();
        $("body > .loading-body").stop(0, 0).fadeOut(400, function () {
          $(this).remove();
        });
      });
    };
    var g = function g() {
      if (window.API_HOST) {
        return a.then(function () {
          if (!NProgress.isStarted()) {
            NProgress.start();
          }
          NProgress.set(0.6);
        }).then(u).then(function () {
          NProgress.done();
        });
      } else {
        return a.then();
      }
    };
    e.loadMain = m;
    e.loadApi = g;
    e.loadOption = d;
    e.loadLang = f;
    e.loadPlugin = c;
  },
  "63": function (t, e, n) {
    "use strict";

    Object.defineProperty(e, "__esModule", {
      value: true
    });
    e.default = function () {
      i();
      l();
      o();
      r();
      s();
      Events.trigger("windowReady");
      var t = document.createEvent("CustomEvent");
      t.initCustomEvent("kodReadyView", true, true, {
        source: window
      });
      document.dispatchEvent(t);
    };
    var i = function i() {
      var t;
      if ($.fn.perfectScroll) {
        t = function t() {
          $(".perfectScroll").perfectScroll();
        };
        $(window).bind("resize", t);
        $(window).bind("scoller", t);
      }
    };
    var l = function l() {
      var t;
      var o;
      var a;
      var n;
      var e;
      if ($.fn.poshytip) {
        t = $("[title]");
        a = {
          className: "ptips-skin",
          liveEvents: !(o = false),
          slide: false,
          alignTo: "cursor",
          alignX: "right",
          alignY: "bottom",
          showAniDuration: 150,
          hideAniDuration: 200,
          offsetY: 10,
          offsetX: 20,
          showTimeout: function r(t) {
            var e = 1500;
            var n = $(t.$elm);
            if (n.attr("title-timeout")) {
              e = parseInt(n.attr("title-timeout"));
            } else if ((n = n.parentNode("[title-root-set]")) && n.attr("title-timeout")) {
              e = parseInt(n.attr("title-timeout"));
            }
            var i = function i() {
              t.opts.showAniDuration = 150;
              t.opts.hideAniDuration = 200;
            };
            var n = 100;
            if (timeFloat() - $.fn.poshytip.lastHideBefore < 0.15) {
              clearTimeout(o);
              o = setTimeout(i, n + 10);
              if (e <= n) {
                return e;
              } else {
                return n;
              }
            } else {
              i();
              return e;
            }
          },
          content: function s(t) {
            var e;
            var n;
            var i;
            var o;
            var a = $(this);
            if (!$.isDraging && !$(this).hasClass("context-menu-active") && !$(this).is(":focus") && !a.hasClass("disable") && !a.hasClass("disable-title")) {
              i = a.attr("title-skin");
              o = a.attr("title-position");
              if (e = a.parentNode("[title-root-set]")) {
                i = e.attr("title-skin");
                o = e.attr("title-position");
              }
              t.addClass(i || "yellow");
              if (o) {
                e = ["center bottom", "center top-5"];
                if (!(n = (n = o.split(",")).length != 2 ? e : n)[0]) {
                  n[0] = e[0];
                }
                n[1] ||= e[1];
                setTimeout(function () {
                  t.position({
                    my: n[0],
                    at: n[1],
                    of: a,
                    collision: "flipfit flipfit"
                  });
                }, 0);
              }
              if ((i = $(this).data("titleCreate")) && _.isFunction(i)) {
                return i($(this));
              } else {
                o = $(this).data("title.poshytip");
                return (o = (o = (o = $(this).attr("title-data") ? (a = $($(this).attr("title-data"))).is("input") || a.is("textarea") ? a.val() : a.html() : o) || "").indexOf("<") == -1 && o.indexOf(">") == -1 ? o.replace(/\n/g, "<br/>") : o).replace(/ /g, " ");
              }
            }
          }
        };
        n = $.fn.attr;
        $.fn.attr = function (t, e) {
          if (t == "title" && e !== undefined && e && $(this).data("title.poshytip")) {
            $(this).data("title.poshytip", e);
          }
          return n.apply(this, arguments);
        };
        if ($.isWindowTouch()) {
          _.extend(a, {
            showOn: "none",
            alignTo: "target",
            liveEvents: false,
            className: "ptips-skin dark title-show tips-arrow arrow-left",
            showAniDuration: 100,
            hideAniDuration: 100
          });
        } else {
          t.poshytip(a);
        }
        $(document).bind("touchstart", function (t) {
          e(t);
          var n;
          var i;
          var o = $.targetParent(t, "[title]");
          if (o && ((n = o.data("poshytip")) || (o.poshytip(a), n = o.data("poshytip")), n)) {
            i = n.$tip.addClass("hidden");
            n.showDelayed();
            n.display = function (t) {
              var e = i.data("active");
              if ((!e || !!t) && (!!e || !t)) {
                if (t) {
                  n.reset();
                } else {
                  i.css("visibility", "inherit").removeClass("hidden");
                  i.attr("class", a.className);
                  i.position({
                    my: "center bottom-20",
                    at: "center top",
                    of: o,
                    collision: "flipfit flipfit"
                  });
                }
                i.data("active", !e);
              }
            };
          }
        });
        e = function e(t) {
          if ($.fn.poshytip && !$(t.target).attr("data-require")) {
            $("[title]").poshytip("clearTimeouts").poshytip("hide");
            $(".ptips-skin").remove();
            $.fn.poshytip.lastHideBefore = 0;
          }
        };
        $(document).bind("mousedown mouseup click touchend", e);
        $("input,textarea").live("focus", e);
      }
    };
    var o = function o() {
      if (window.API_HOST) {
        template.defaults.cache = true;
        template.defaults.minimize = false;
        template.defaults.compileDebug = false;
      }
    };
    var a = function a() {
      var t;
      var e;
      if (!$.isWindowTouch()) {
        t = [".hover-animate-item", ".menuBar .menu-item", ".menu-group-submenu .menu-item-sub", ".menuBar .menu-dropdown-user li.ripple-item", ".setting-menu-left .menu-item-content", ".admin-menu-left .menu-item-content", ".frame-main-explorer .file-panel > .tab-group-line .tab-item"].join(",");
        e = [".disable,.disabled,.not-selectable", ".select", ".this", ".hover-active", ".active", ".menuBar .menu-group.open > .menu-item", ".setting-menu-left .menu-item.select .menu-item-content", ".admin-menu-left .menu-item.select .menu-item-content"].join(",");
        $.hoverAnimate({
          el: t,
          delegate: "body",
          disable: e,
          scale: 1
        });
      }
    };
    var r = function r() {
      var s;
      var t = ["a,button,.ripple-item,.kui-btn,.btn,[ripple-item],.button.switch", ".form-row.style-list-block label"].join(",");
      var e = t + ",.context-menu-item";
      if ($.isWindowTouch()) {
        e = t;
      }
      loadRipple(e, ".disable-ripple,.disabled,.disable,.ztree a.tree-node,.not-selectable,.tox-tbtn--disabled");
      a();
      $(window).bind("resize", function () {
        Events.trigger("window.resize");
      });
      $(document).bind("dragover", function (t) {
        return !!$(t.target).isEdit() || stopPP(t);
      }).bind("drop", stopPP);
      $("body").delegate(".password-view", "click", function (t) {
        var e;
        var n;
        var i = $(this);
        var o = i.parent().children("input[type=\"password\"],input.input-password").not("._password-input");
        if (o.length == 1) {
          if (o.hasClass("input-password")) {
            i.toggleClass("active");
            o.toggleClass("input-password-show").focus();
          } else if (i.hasClass("active")) {
            o.css("display", "");
            i.removeClass("active");
            $(i.data("textBtn")).remove();
            setTimeout(function () {
              o.focus();
            }, 0);
          } else {
            e = (e = $(o.get(0)).prop("outerHTML")).replace(/type\s*=\s*("|')?password("|')?/i, "type=\"text\"");
            n = $(e).removeAttr("readonly").insertAfter(o);
            o.css("display", "none");
            i.data("textBtn", n).addClass("active");
            n.focus().val(o.val());
            n.addClass("_password-view-field").data("_password-input", o);
            setTimeout(function () {
              n.focus();
            }, 0);
          }
        }
      });
      $("body").delegate("._password-view-field", "change keyup keydown", function (t) {
        var e;
        var n = $(this).data("_password-input");
        if (n.length == 1) {
          (e = jQuery.Event(t.type)).key = t.key;
          e.keyCode = t.keyCode;
          e.which = t.which;
          n.val($(this).val()).trigger(e);
        }
      });
      $("body").delegate("img,a", "dragstart", function (t) {
        return stopPP(t);
      });
      if (window.API_HOST) {
        $("body").delegate("a", "click", function (t) {
          if ($(this).attr("href") == "#") {
            t.preventDefault();
          }
        });
        $("body").delegate("[link-href]", "click", function (t) {
          return s(t, "");
        });
        $("body").delegate("[link-href]", "mouseup", function (t) {
          if (t.which == 2) {
            return s(t, "_blank");
          }
        });
        s = function s(t, e) {
          var n;
          var i = $(t.currentTarget);
          var o = i.attr("link-href") || "#";
          var e = e || i.attr("target");
          var a = _.startsWith(o, "http://") || _.startsWith(o, "https://");
          var r = o;
          if (!a) {
            if (o.startsWith("/") || o.startsWith("./")) {
              if (t.which == 2 || e == "_blank") {
                return $.openWindow(r);
              } else {
                window.location.href = o;
                return;
              }
            }
            r = $.parseUrl().urlPath + (o == "#" ? "" : "#" + _.trim(o, "#"));
          }
          if (i.attr("dialog-open") || e == "dialog") {
            n = i.find(".font-icon").prop("outerHTML") || "";
            n = htmlSafe(n + i.text());
            return core.openDialog(r, "", n);
          } else if (a) {
            return $.openWindow(r, false, e);
          } else if (t.which == 2 || e == "_blank") {
            return $.openWindow(r);
          } else {
            o = o == "#" && window.parent != window ? "#&_a=1" : o;
            Router.go(o);
            return;
          }
        };
      }
    };
    var s = function s() {
      var w = false;
      $.fn.tabCurrent = function (t, e) {
        var n;
        var i;
        var o;
        var a;
        var r;
        var s;
        var l;
        var c;
        var d;
        var u;
        var p;
        var f;
        var h;
        var m;
        var g = $(this);
        if (g && g.length != 0 && (n = g.parent(), a = g.outerWidth(), c = g.offset().left - n.offset().left, (i = n.children(".tab-item-bar")).length != 0) && (o = n.parent(), o = (o = n.attr("tab-pan-parent") ? n.parents(n.attr("tab-pan-parent")) : o).children(".tab-group-pan").children(".tab-content"), i.data("initTab") || (i.data("initTab", 1), o.hide(), i.addClass("no-animate opacity-hidden"), setTimeout(function () {
          i.removeClass("opacity-hidden");
        }, 10), setTimeout(function () {
          n.children(".tab-item.active").tabCurrent();
          i.removeClass("no-animate");
        }, 300)), l = n.scrollLeft() || 0, f = n.offset().top + n.outerHeight(), m = g.offset().top + g.outerHeight(), a = {
          width: (a = +g.width()) + "px",
          left: (c = c + (g.outerWidth() - a) / 2 + l) + "px",
          transform: "translate3d(0px,-" + Math.abs(f - m + 1) + "px, 0px)"
        }, t && i.addClass("no-animate"), i.css(a), n.children(".tab-item").removeClass("active"), g.addClass("active"), r = t ? 0 : 200, (s = (l = (s = n).attr("tab-scroll-parent")) ? n.parents(l).first() : s).attr("ignore-scroll") || g.nodeInScreen(true, s) || (clearTimeout(w), w = setTimeout(function () {
          g.nodeInScreenSet(r, true, s);
        }, r * 0.3)), t && (i.offset(), i.removeClass("no-animate")), o.length)) {
          c = g.attr("tab-name").replace(/'/g, "\\'");
          d = o.filter(":visible");
          u = o.filter("." + c);
          if (d.get(0) != u.get(0)) {
            if (_.isArray(e) && e.length == 4) {
              p = e[0];
              f = parseInt(e[1]) || 0;
              h = e[2];
              m = parseInt(e[3]) || f;
              d.addClass(h);
              u.show().addClass(p);
              setTimeout(function () {
                u.removeClass(p);
              }, f);
              setTimeout(function () {
                d.hide().removeClass(h);
              }, m);
            } else {
              d.switchTo(u);
            }
          }
          g.trigger("tab-select");
        }
        return this;
      };
      $(document).delegate(".tab-group-line .tab-item", "click", function () {
        if (!$(this).attr("link-href") || $(this).parent().attr("tab-tirgger") != "self") {
          $(this).tabCurrent(false);
        }
      });
      var t = _.debounce(function () {
        $(".tab-group-line .tab-item.active:visible").filter(":visible").each(function () {
          $(this).tabCurrent(true);
        });
      }, 50);
      $(window).bind("resize", t);
      $(window).bind("tab-select", function (t) {
        $(".tab-group-line .tab-item.active:visible").each(function () {
          var t = $(this);
          if (!t.data("_eventTabSelect")) {
            t.data("_eventTabSelect", 1);
            setTimeout(function () {
              t.data("_eventTabSelect", 0);
            }, 200);
            setTimeout(function () {
              t.tabCurrent(false);
            }, 30);
          }
        });
      });
      if ($.isWindowTouch()) {
        c();
      }
      $.fn.tabCurrentKeep = function (t) {
        var e = $(this);
        var n = $(this).first().parent();
        if (e.length) {
          if (!n.attr("tab-keep-init")) {
            e.bind("tab-select", function () {
              LocalData.set(t, $(this).attr("tab-name"));
            });
            n.attr("tab-keep-init", "1");
          }
          n = LocalData.get(t);
          (n = (n = e.filter("[tab-name=\"" + n + "\"]")).length ? n : e.first()).tabCurrent();
          setTimeout(function () {
            e.filter(".active").trigger("click");
          }, 100);
          return this;
        }
      };
    };
    var c = function c() {};
  },
  "701": function (t, e, n) {
    t.exports = n(702);
  },
  "702": function (t, e, n) {
    "use strict";

    var i = n(23);
    var o = a(n(63));
    function a(t) {
      if (t && t.__esModule) {
        return t;
      } else {
        return {
          default: t
        };
      }
    }
    (0, i.loadApi)().then(function () {
      (0, o.default)();
    });
  }
}); //# sourceMappingURL=lib.js.map?v=4fe338aa