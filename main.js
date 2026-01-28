const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const fs = require("fs");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: __dirname + "/preload.js",
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(__dirname + "/renderer/index.html");
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("pickImage", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle("savePng", async (_evt, { pngBuffer }) => {
  const res = await dialog.showSaveDialog({
    filters: [{ name: "PNG", extensions: ["png"] }],
    defaultPath: "crosshatch.png",
  });
  if (res.canceled || !res.filePath) return { ok: false };

  fs.writeFileSync(res.filePath, Buffer.from(pngBuffer));
  return { ok: true, path: res.filePath };
});
