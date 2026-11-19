// Images pasted into a terminal, and files dropped onto it (upload plugin).
//
// The browser's clipboard is not the one the pane's program reads: Claude Code
// or Codex on the pane's machine looks at that machine's clipboard, so ⌘V of a
// screenshot reached them as an empty paste. Instead the file goes to the
// pane's machine (/api/upload) and its path is pasted: both agents turn a
// pasted image path into an attachment, and a shell simply gets the path.
(function (global) {
  'use strict';

  // The image types the agents attach; anything else is converted to PNG first.
  var AGENT_IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  var MAX_FILES = 10;
  var GENERIC_NAMES = /^(?:image|images|blob|clipboard|pasted|untitled|upload|file)$/i;

  function lines(text) {
    return String(text || '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  }

  function baseName(text) {
    var value = String(text).replace(/^file:\/\//i, '');
    try { value = decodeURIComponent(value); } catch (_e) { /* keep it as typed */ }
    return value.replace(/^["']|["']$/g, '').split(/[\\/]/).pop();
  }

  /**
   * The images to upload in place of a paste; empty when the paste is text.
   * A spreadsheet or document puts a picture of the selection beside its
   * text, and that paste is the text. A copied file brings its own name or
   * path as text, and a browser's "Copy Image" its address: those are the image.
   */
  function pastedImages(data) {
    if (!data) return [];
    var files = [];
    var items = data.items || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || item.kind !== 'file' || !/^image\//i.test(item.type || '')) continue;
      var file = item.getAsFile && item.getAsFile();
      if (file) files.push(file);
    }
    if (!files.length) {
      var list = data.files || [];
      for (var j = 0; j < list.length; j++) {
        if (/^image\//i.test(list[j].type || '')) files.push(list[j]);
      }
    }
    if (!files.length) return [];
    var text = '';
    try { text = data.getData('text/plain') || ''; } catch (_e) { /* no text */ }
    var names = files.map(function (file) { return file.name; });
    var describesFiles = lines(text).every(function (line) {
      return /^(?:https?|file):\/\//i.test(line) || names.indexOf(baseName(line)) >= 0;
    });
    return describesFiles ? files.slice(0, MAX_FILES) : [];
  }

  /** Files dropped from the computer (not text, links or panel tabs being dragged). */
  function droppedFiles(data) {
    if (!data || !data.files || !data.files.length) return [];
    var files = [];
    var items = data.items || [];
    for (var i = 0; i < data.files.length; i++) {
      var entry = items[i] && items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) continue;
      files.push(data.files[i]);
    }
    return files.slice(0, MAX_FILES);
  }

  function carriesFiles(data) {
    var types = data && data.types;
    if (!types) return false;
    for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  }

  /** What the agents can read: PNG when the browser can draw the image, else as given. */
  function agentReadable(file) {
    var type = String(file.type || '').toLowerCase();
    if (!/^image\//.test(type) || AGENT_IMAGE_TYPES[type]) return Promise.resolve(file);
    var doc = global.document;
    if (typeof global.createImageBitmap !== 'function' || !doc) return Promise.resolve(file);
    var name = String(file.name || 'image').replace(/\.[^.]*$/, '') + '.png';
    return global.createImageBitmap(file).then(function (bitmap) {
      var canvas = doc.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) { resolve(blob ? new global.File([blob], name, { type: 'image/png' }) : file); }, 'image/png');
      });
    }).catch(function () { return file; });
  }

  /**
   * The name the file is stored under: no spaces or shell characters, so the
   * pasted path is one word, and an extension the agents recognise.
   */
  function uploadName(file, index, count) {
    var name = String(file.name || '');
    var dot = name.lastIndexOf('.');
    var stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80);
    var extension = AGENT_IMAGE_TYPES[String(file.type || '').toLowerCase()]
      || (dot > 0 ? name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 10) : '');
    if (!stem || GENERIC_NAMES.test(stem)) stem = 'paste';
    if (count > 1) stem += '-' + (index + 1);
    return extension ? stem + '.' + extension : stem;
  }

  /** The path as one word for a shell; Claude Code and Codex strip the quotes. */
  function pasteText(path) {
    if (!/[\s'"$`\\!&;|<>()*?#~]/.test(path)) return path;
    return path.indexOf("'") < 0 ? "'" + path + "'" : '"' + path.replace(/(["$`\\])/g, '\\$1') + '"';
  }

  function headers() {
    var auth = global.Auth;
    return auth && typeof auth.headers === 'function' ? auth.headers() : {};
  }

  /** Stores the file on the server's machine; resolves to the path to paste. */
  function upload(serverId, file, name) {
    var form = new global.FormData();
    form.append('file', file, name);
    var api = global.Api;
    var url = api && api.nodeUrl ? api.nodeUrl(serverId, '/api/upload') : '/api/upload';
    return global.fetch(url, { method: 'POST', headers: headers(), body: form }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        var data = body && body.data;
        if (!res.ok || !data || typeof data.path !== 'string') {
          throw new Error((body && body.error) || ('HTTP ' + res.status));
        }
        // A Node from before nativePath reports only the shell's path.
        return typeof data.nativePath === 'string' ? data.nativePath : data.path;
      });
    });
  }

  /**
   * Takes over image pastes and file drops on a terminal element.
   *
   * options.serverId()  the machine the pane is on, or null when it takes no uploads
   * options.isCurrent() the terminal still shows that pane (checked after the upload)
   * options.paste(text) sends text as a paste; false when the terminal is not connected
   * options.notify(msg) shows a short message
   * options.copy(text)  puts text on the clipboard when it cannot be pasted
   */
  function install(element, options) {
    if (!element || !options) return function () {};
    var queue = Promise.resolve();
    var notify = function (message, duration) {
      var show = options.notify || global._showToast;
      if (typeof show === 'function') show(message, duration);
    };

    function send(files, what) {
      var serverId = options.serverId();
      if (serverId == null) {
        notify('该服务器未安装面板服务，无法上传' + what, 3000);
        return;
      }
      notify(files.length > 1 ? '正在上传 ' + files.length + ' 个' + what + '…' : '正在上传' + what + '…', 1500);
      var uploads = Promise.all(files.map(function (file, index) {
        return agentReadable(file).then(function (readable) {
          return upload(serverId, readable, uploadName(readable, index, files.length));
        });
      }));
      // Pastes land in the order they were made, whichever upload finishes first.
      queue = queue.then(function () { return uploads; }).then(function (paths) {
        var texts = paths.map(pasteText);
        if (!options.isCurrent()) {
          if (options.copy) options.copy(texts.join(' '));
          notify('终端已切换，路径已复制', 3000);
          return;
        }
        for (var i = 0; i < texts.length; i++) {
          // One paste per path: Claude Code reads a paste of several Windows
          // paths as one path. The space keeps them apart in a shell.
          if (options.paste(texts[i] + (i < texts.length - 1 ? ' ' : '')) === false) {
            if (options.copy) options.copy(texts.join(' '));
            notify('终端未连接，路径已复制', 3000);
            return;
          }
        }
      }).catch(function (error) {
        notify('上传失败：' + ((error && error.message) || error), 3500);
      });
    }

    function onPaste(event) {
      var files = pastedImages(event.clipboardData);
      if (!files.length) return;
      // Before xterm turns it into an empty paste.
      event.preventDefault();
      event.stopImmediatePropagation();
      send(files, '图片');
    }
    function onDragOver(event) {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
    function onDrop(event) {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      var files = droppedFiles(event.dataTransfer);
      if (!files.length) { notify('不支持拖入文件夹', 3000); return; }
      send(files, '文件');
    }

    element.addEventListener('paste', onPaste, true);
    element.addEventListener('dragover', onDragOver);
    element.addEventListener('drop', onDrop);
    return function () {
      element.removeEventListener('paste', onPaste, true);
      element.removeEventListener('dragover', onDragOver);
      element.removeEventListener('drop', onDrop);
    };
  }

  global.TerminalUpload = {
    install: install,
    pastedImages: pastedImages,
    droppedFiles: droppedFiles,
    uploadName: uploadName,
    pasteText: pasteText,
    upload: upload,
  };
})(typeof window !== 'undefined' ? window : globalThis);
