export type AdminRole = "viewer" | "operator" | "admin";

export type AdminIdentity = {
  id: string;
  username: string;
  role: AdminRole;
};

export type AdminLoginRequest = {
  username: string;
  password: string;
};

export type AdminLoginResult = {
  token: string;
  expiresAt: number;
  admin: AdminIdentity;
};

export type AdminMeResult = AdminIdentity & {
  expiresAt: number;
  lastSeenAt: number;
};

export type AdminLogoutResult = {
  success: boolean;
};
