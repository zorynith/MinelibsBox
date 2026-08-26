/**
 * 国际化管理类 - JavaScript版本
 */
class I18n {
  constructor() {
    this.loaded = false;
    this.lang = null;
    this.langType = 'zh-CN';
    this.data = {};
  }

  /**
   * 初始化语言包
   */
  init() {
    if (this.loaded) return;

    // 从URL参数获取语言
    const urlParams = new URLSearchParams(window.location.search);
    let lang = urlParams.get('lang') || 'zh-CN';

    // 从localStorage获取用户设置的语言
    const savedLang = localStorage.getItem('userLanguage');
    if (savedLang) {
      lang = savedLang;
    }

    // 从浏览器语言检测
    if (!savedLang && !urlParams.get('lang')) {
      lang = this.detectBrowserLanguage();
    }

    // 确保语言格式正确
    lang = this.normalizeLanguage(lang);
    
    // 设置语言
    this.setLanguage(lang);
  }

  /**
   * 检测浏览器语言
   */
  detectBrowserLanguage() {
    const browserLang = navigator.language || navigator['userLanguage'] || 'zh-CN';
    
    // 语言映射
    const langMap = {
      'zh': 'zh-CN',
      'zh-CN': 'zh-CN',
      'zh-TW': 'zh-TW',
      'zh-HK': 'zh-TW',
      'en': 'en',
      'en-US': 'en',
      'en-GB': 'en',
      'ja': 'ja',
      'ko': 'ko',
      'fr': 'fr',
      'de': 'de',
      'es': 'es',
      'it': 'it',
      'pt': 'pt',
      'ru': 'ru',
      'ar': 'ar'
    };

    // 简化语言代码
    const simplifiedLang = browserLang.split('-')[0].toLowerCase();
    
    // 返回映射的语言，如果没有映射则默认为中文
    return langMap[simplifiedLang] || langMap[browserLang] || 'zh-CN';
  }

  /**
   * 标准化语言代码
   */
  normalizeLanguage(lang) {
    const normalizeMap = {
      'zh_CN': 'zh-CN',
      'zh-tw': 'zh-TW',
      'zh_cn': 'zh-CN',
      'en_us': 'en',
      'en_US': 'en',
      'zh': 'zh-CN'
    };

    return normalizeMap[lang] || lang;
  }

  /**
   * 设置语言
   */
  setLanguage(lang) {
    this.langType = lang;
    this.lang = this.loadLanguageFile(lang);
    this.loaded = true;
    
    // 保存到localStorage
    localStorage.setItem('userLanguage', lang);
    
    // 更新HTML的lang属性
    document.documentElement.lang = lang;
  }

  /**
   * 加载语言文件
   */
  loadLanguageFile(lang) {
    try {
      // 尝试从本地存储加载
      const cachedLang = localStorage.getItem(`lang_${lang}`);
      if (cachedLang) {
        return JSON.parse(cachedLang);
      }

      // 尝试从网络加载
      const langFileUrl = `/config/i18n/${lang}/index.json`;
      const xhr = new XMLHttpRequest();
      xhr.open('GET', langFileUrl, false);
      xhr.send();
      
      if (xhr.status === 200) {
        const langData = JSON.parse(xhr.responseText);
        // 缓存到本地存储
        localStorage.setItem(`lang_${lang}`, JSON.stringify(langData));
        return langData;
      }
    } catch (error) {
      console.warn(`Failed to load language file for ${lang}:`, error);
    }

    // 如果加载失败，返回默认语言
    return this.getDefaultLanguage();
  }

  /**
   * 获取默认语言包
   */
  getDefaultLanguage() {
    return {
      "common.copyright.homepage": "",
      "common.copyright.powerBy": "Powered by MbesBox",
      "common.copyright.name": "MbesBox",
      "common.copyright.desc": "——Minelibs Resource Manager",
      "common.copyright.metaKeywords": "Minelibs,Resource Manager",
      "common.copyright.metaName": "MbesBox",
      "common.copyright.downloadLink": "",
      "common.loginTitle": "登录",
      "common.login": "登录",
      "common.username": "用户名",
      "common.password": "密码",
      "common.ok": "确定",
      "common.cancel": "取消",
      "common.remember": "记住密码",
      "common.edit": "编辑",
      "common.save": "保存",
      "common.delete": "删除",
      "common.add": "添加",
      "common.update": "更新",
      "common.loading": "加载中...",
      "common.error": "错误",
      "common.success": "成功",
      "common.warning": "警告",
      "common.info": "信息",
      "user.loginError": "登录失败",
      "user.pwdError": "密码错误",
      "user.userNotExist": "用户不存在",
      "user.pwdNotNull": "密码不能为空",
      "user.rootPwdEqual": "两次密码不一致",
      "user.logout": "退出登录",
      "user.profile": "个人资料",
      "user.settings": "设置",
      "user.admin": "管理员",
      "title": "MbesBox",
      "system.loading": "系统加载中...",
      "system.error": "系统错误",
      "system.maintenance": "系统维护中",
      "system.upgrade": "系统升级中"
    };
  }

  /**
   * 获取语言文本
   */
  get(key, ...args) {
    this.init();
    
    if (!this.lang || !this.lang[key]) {
      // 如果没有找到对应的翻译，返回key本身
      return key;
    }

    // 如果有参数，进行字符串格式化
    if (args.length > 0) {
      return this.formatString(this.lang[key], args);
    }

    return this.lang[key];
  }

  /**
   * 字符串格式化
   */
  formatString(str, args) {
    return str.replace(/\{(\d+)\}/g, (match, index) => {
      return args[index] || match;
    });
  }

  /**
   * 获取所有语言包
   */
  getAll() {
    this.init();
    return this.lang;
  }

  /**
   * 获取当前语言类型
   */
  getType() {
    this.init();
    return this.langType;
  }

  /**
   * 设置语言包
   */
  set(langData) {
    this.init();
    if (typeof langData === 'string') {
      this.lang[langData] = '';
    } else if (typeof langData === 'object') {
      Object.assign(this.lang, langData);
    }
  }

  /**
   * 添加新的语言包
   */
  addLanguage(lang, langData) {
    // 这里可以添加新语言包的逻辑
    console.log(`Adding language pack: ${lang}`, langData);
  }

  /**
   * 获取支持的语言列表
   */
  getSupportedLanguages() {
    return {
      'zh-CN': '简体中文',
      'en': 'English',
      'zh-TW': '繁體中文',
      'ja': '日本語',
      'ko': '한국어',
      'fr': 'Français',
      'de': 'Deutsch',
      'es': 'Español',
      'it': 'Italiano',
      'pt': 'Português',
      'ru': 'Русский',
      'ar': 'العربية'
    };
  }

  /**
   * 切换语言
   */
  switchLanguage(lang) {
    this.setLanguage(lang);
    
    // 触发语言切换事件
    window.dispatchEvent(new CustomEvent('languageChanged', {
      detail: { language: lang }
    }));
  }

  /**
   * 检查语言是否支持
   */
  isLanguageSupported(lang) {
    const supportedLangs = Object.keys(this.getSupportedLanguages());
    return supportedLangs.includes(lang);
  }

  /**
   * 清除语言缓存
   */
  clearCache() {
    localStorage.removeItem(`lang_${this.langType}`);
    this.loaded = false;
    this.init();
  }
}

// 创建全局实例
window.I18n = window.I18n || new I18n();

// 兼容全局LNG函数 - 仅在 window.LNG 尚未定义时创建，避免覆盖扁平语言包对象
if (!window.LNG || typeof window.LNG !== "object") {
  window.LNG = function(key, ...args) {
    return window.I18n.get(key, ...args);
  };
}

// 设置默认语言
window.I18n.init();