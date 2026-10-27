/* Zotero 10 bootstrap. No Zotero database files are opened directly. */
var NotebookPlugin;
async function startup(data, reason) {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  Services.scriptloader.loadSubScript(data.rootURI+'updater.js',this);
  Services.scriptloader.loadSubScript(data.rootURI+'translation.js',this);
  Services.scriptloader.loadSubScript(data.rootURI+'dock.js',this);
  Services.scriptloader.loadSubScript(data.rootURI+'integrations.js',this);
  Services.scriptloader.loadSubScript(data.rootURI+'literature.js',this);
  Services.scriptloader.loadSubScript(data.rootURI+'notebook.js',this);
  NotebookPlugin=ResearchNotebookPlugin;
  await NotebookPlugin.start(data);
}
function shutdown(data, reason) {
  if (reason===APP_SHUTDOWN) return;
  NotebookPlugin?.stop();
}
function install() {}
function uninstall() {}
function onMainWindowLoad({window}) { NotebookPlugin?.addWindow(window); }
function onMainWindowUnload({window}) { NotebookPlugin?.removeWindow(window); }
