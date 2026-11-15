/* Bootstraps Monaco's AMD editor worker; buffers messages until the module is loaded. */
var queue = [];
self.onmessage = function (e) { queue.push(e); };
importScripts('../../node_modules/monaco-editor/min/vs/loader.js');
self.require.config({ baseUrl: '../../node_modules/monaco-editor/min/' });
self.require(['vs/editor/editor.worker'], function () {
  var handler = self.onmessage;
  queue.forEach(function (e) { handler(e); });
  queue = null;
});
