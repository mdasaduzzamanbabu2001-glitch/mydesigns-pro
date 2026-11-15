const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    startTask: (data) => ipcRenderer.send('start-automation', data),
    toggleView: (show) => ipcRenderer.send('toggle-view', show),
    refreshGallery: () => ipcRenderer.send('refresh-gallery'),
    startReset: () => ipcRenderer.send('start-reset'),

    onGalleryData: (callback) => {
        ipcRenderer.removeAllListeners('gallery-data');
        ipcRenderer.on('gallery-data', (_event, data) => callback(data));
    },
    onProgressUpdate: (callback) => {
        ipcRenderer.removeAllListeners('progress-update');
        ipcRenderer.on('progress-update', (_event, data) => callback(data));
    },
    onStatusUpdate: (callback) => {
        ipcRenderer.removeAllListeners('status-update');
        ipcRenderer.on('status-update', (_event, message) => callback(message));
    },

    // 🚀 Live Online Auto-Update Bridges
    checkForUpdate: (isManual = false) => ipcRenderer.send('check-for-update', isManual),
    startLiveUpdate: () => ipcRenderer.send('start-live-update'),
    onAppVersion: (callback) => {
        ipcRenderer.removeAllListeners('app-version');
        ipcRenderer.on('app-version', (_event, version) => callback(version));
    },
    onUpdateAvailable: (callback) => {
        ipcRenderer.removeAllListeners('update-available');
        ipcRenderer.on('update-available', (_event, info) => callback(info));
    },
    onUpdateStatus: (callback) => {
        ipcRenderer.removeAllListeners('update-status');
        ipcRenderer.on('update-status', (_event, status) => callback(status));
    }
});