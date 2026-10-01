import { app, BrowserWindow } from "electron";
import { join } from "node:path";

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const devUrl = process.env.OMO_UI_DEV_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, "../dist/index.html"));
}

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
