const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickImage: () => ipcRenderer.invoke("pickImage"),
  savePng: (pngBuffer) => ipcRenderer.invoke("savePng", { pngBuffer }),
});
