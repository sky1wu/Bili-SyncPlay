import { createAdminApp } from "./app-runtime.js";
import { state } from "./state.js";

const app = createAdminApp({ state });

app.installPopStateHandler();

app.bootstrap().catch((error) => {
  console.error(error);
  state.notice = { type: "error", message: "管理控制面板初始化失败。" };
  app.render().catch(app.handleFatalRenderError);
});
