import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { AppLayout } from "./layout/app-layout.js";
import { NAV_ITEMS } from "./layout/nav-items.js";
import { LoginPage } from "./pages/login-page.js";
import { PlaceholderPage } from "./pages/placeholder-page.js";

export function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntdApp>
        <BrowserRouter basename="/admin-next">
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                element={
                  <RequireAuth>
                    <AppLayout />
                  </RequireAuth>
                }
              >
                <Route index element={<Navigate to="/overview" replace />} />
                {NAV_ITEMS.map((item) => (
                  <Route
                    key={item.path}
                    path={item.path}
                    element={
                      <PlaceholderPage
                        title={item.label}
                        description={item.description}
                      />
                    }
                  />
                ))}
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Route>
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}
