'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onStateChange(callback) {
    const handler = (_, payload) => callback(payload)
    ipcRenderer.on('state-change', handler)
    return () => ipcRenderer.removeListener('state-change', handler)
  },
  widgetUiReady: () => ipcRenderer.invoke('widget-ui-ready'),
  minimizeWidget: () => ipcRenderer.invoke('minimize-widget'),
  resizeWidget: (size) => ipcRenderer.invoke('resize-widget', size),
  getLastTone: () => ipcRenderer.invoke('get-last-tone'),
  setLastTone: (tone) => ipcRenderer.invoke('set-last-tone', tone),
  dismissWidget: () => ipcRenderer.invoke('dismiss-widget'),
  pasteBack: (text) => ipcRenderer.invoke('paste-back', text),
  getSetupState: () => ipcRenderer.invoke('get-setup-state'),
  getBackendConfig: () => ipcRenderer.invoke('get-backend-config'),
  saveAccessKey: (key) => ipcRenderer.invoke('save-access-key', key),
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
  saveLlmSettings: (cfg) => ipcRenderer.invoke('save-llm-settings', cfg),
  retrySetup: () => ipcRenderer.invoke('retry-setup'),
  finishSetup: () => ipcRenderer.invoke('finish-setup'),
  onSetupProgress(callback) {
    const handler = (_, payload) => callback(payload)
    ipcRenderer.on('setup-progress', handler)
    return () => ipcRenderer.removeListener('setup-progress', handler)
  },
})
