import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const rootElement = document.querySelector("#root");
if (!rootElement) {
  throw new Error("找不到 #root 挂载点。");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
