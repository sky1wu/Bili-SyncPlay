import { QueryClientProvider } from "@tanstack/react-query";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { createQueryClient } from "./data/query-client.js";
import { AppLayout } from "./layout/app-layout.js";
import { NAV_ITEMS } from "./layout/nav-items.js";
import { LoginPage } from "./pages/login-page.js";
import { OverviewPage } from "./pages/overview/overview-page.js";
import { PlaceholderPage } from "./pages/placeholder-page.js";

export function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <ConfigProvider locale={zhCN}>
      <AntdApp>
        <QueryClientProvider client={queryClient}>
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
                  <Route path="/overview" element={<OverviewPage />} />
                  {NAV_ITEMS.filter((item) => item.path !== "/overview").map(
                    (item) => (
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
                    ),
                  )}
                  <Route
                    path="*"
                    element={<Navigate to="/overview" replace />}
                  />
                </Route>
              </Routes>
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
