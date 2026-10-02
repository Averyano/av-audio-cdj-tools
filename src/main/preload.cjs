// Sandboxed preloads must be CommonJS; this is the only bridge to the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: (kind) => ipcRenderer.invoke('dialog:pickFolder', kind),
  status: () => ipcRenderer.invoke('engine:status'),
  scan: () => ipcRenderer.invoke('engine:scan'),
  convert: () => ipcRenderer.invoke('engine:convert'),
  cancel: () => ipcRenderer.invoke('engine:cancel'),
  playlistState: () => ipcRenderer.invoke('playlist:state'),
  pickPlaylist: () => ipcRenderer.invoke('playlist:pick'),
  matchPlaylist: () => ipcRenderer.invoke('playlist:match'),
  pickPlaylistTrack: (index) => ipcRenderer.invoke('playlist:pickTrack', index),
  savePlaylist: () => ipcRenderer.invoke('playlist:save'),
  searchPlaylistFolder: () => ipcRenderer.invoke('playlist:searchFolder'),
  cancelPlaylistSearch: () => ipcRenderer.invoke('playlist:cancelSearch'),
  onPlaylistProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('playlist:progress', listener);
    return () => ipcRenderer.removeListener('playlist:progress', listener);
  },
  analyzerPick: (slot) => ipcRenderer.invoke('analyzer:pick', slot),
  // Drag and drop: the path is resolved here, never by the page. A File the page made itself
  // has no path ('') and is refused by main.
  analyzerDrop: (slot, file) => ipcRenderer.invoke('analyzer:file', slot, webUtils.getPathForFile(file)),
  analyzerCancel: (slot) => ipcRenderer.invoke('analyzer:cancel', slot),
  onAnalyzerTempoKey: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('analyzer:tempoKey', listener);
    return () => ipcRenderer.removeListener('analyzer:tempoKey', listener);
  },
  onAnalyzerProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('analyzer:progress', listener);
    return () => ipcRenderer.removeListener('analyzer:progress', listener);
  },
  listenAccess: () => ipcRenderer.invoke('listen:access'),
  listenAnalyze: (samples, sampleRate) => ipcRenderer.invoke('listen:analyze', samples, sampleRate),
  listenLineInputs: () => ipcRenderer.invoke('listen:lineInputs'),
  listenCaptureLine: (opts) => ipcRenderer.invoke('listen:captureLine', opts),
  listenStopLine: (discard) => ipcRenderer.invoke('listen:stopLine', discard),
  onListenColumn: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('listen:column', listener);
    return () => ipcRenderer.removeListener('listen:column', listener);
  },
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openLink: (name) => ipcRenderer.invoke('shell:openLink', name), // 'email' | 'ffmpeg' | 'releases', URLs fixed in main
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  skipUpdate: () => ipcRenderer.invoke('update:skip'),
  onUpdate: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  pickFfmpeg: () => ipcRenderer.invoke('ffmpeg:pick'),
  resetFfmpeg: () => ipcRenderer.invoke('ffmpeg:reset'),
  recheckFfmpeg: () => ipcRenderer.invoke('ffmpeg:recheck'),
  onAppError: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('app:error', listener);
    return () => ipcRenderer.removeListener('app:error', listener);
  },
  onProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('engine:progress', listener);
    return () => ipcRenderer.removeListener('engine:progress', listener);
  },
});
