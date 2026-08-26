(function () {
  function applyConfig() {
    if (!window.readerControl) return false;
    if (window.__pdfTronConfigApplied) return true;
    window.__pdfTronConfigApplied = true;

    var cfg = {};
    try { cfg = JSON.parse(readerControl.getCustomData() || '{}'); } catch (e) { cfg = {}; }

    if (cfg.lang) { try { readerControl.setLanguage(cfg.lang); } catch (e) {} }
    if (cfg.darktheme) { try { readerControl.setTheme('dark'); } catch (e) {} }
    if (cfg.viewOnly) { try { readerControl.disableElements(['downloadButton', 'printButton']); } catch (e) {} }

    if (cfg.canWrite && cfg.savetofile && cfg.saveUrl) {
      try {
        readerControl.setHeaderItems(function (header) {
          header.push({
            type: 'actionButton',
            title: cfg.lngSave || 'Save',
            img: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="none"/><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>',
            onClick: async function () {
              try {
                var doc = readerControl.docViewer.getDocument();
                var xfdfString = await readerControl.docViewer.getAnnotationManager().exportAnnotations();
                var data = await doc.getFileData({ xfdfString: xfdfString });
                var arr = new Uint8Array(data);
                var blob = new Blob([arr], { type: 'application/pdf' });
                var req = new XMLHttpRequest();
                req.open('POST', cfg.saveUrl);
                req.onload = function () {
                  if ((req.status >= 200 && req.status < 300) || req.status === 304) {
                    alert(cfg.lngSaveSuccess || 'Saved');
                  }
                };
                try { req.send(blob); } catch (e) { alert(cfg.lngError || 'Operation failed'); }
              } catch (e) { alert(cfg.lngError || 'Operation failed'); }
            }
          });
        });
      } catch (e) {}
    }
    return true;
  }

  if (applyConfig()) return;
  window.addEventListener('viewerLoaded', function () { applyConfig(); });
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (applyConfig()) clearInterval(timer);
    else if (tries >= 60) clearInterval(timer);
  }, 500);
})();
