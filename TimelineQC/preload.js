const { contextBridge, ipcRenderer } = require("electron/renderer");

contextBridge.exposeInMainWorld("timelineQC", {
    invoke: (action, params) => ipcRenderer.invoke("timelineqc:invoke", action, params || {}),
    getTimelineInfo: () => ipcRenderer.invoke("timelineqc:invoke", "get_timeline_info", {}),
    getTimelineList: () => ipcRenderer.invoke("timelineqc:invoke", "get_timeline_list", {}),
    selectTimeline: (index) => ipcRenderer.invoke("timelineqc:invoke", "select_timeline", { index }),
    runCheck: (params) => ipcRenderer.invoke("timelineqc:invoke", "run_check", params || {}),
    clearMarkers: () => ipcRenderer.invoke("timelineqc:invoke", "clear_markers", {}),
    checkUpdate: (params) => ipcRenderer.invoke("timelineqc:invoke", "check_update", params || {}),
});
