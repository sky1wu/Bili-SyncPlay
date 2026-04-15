export async function reportCurrentUser(
  sendMessage: (message: unknown) => Promise<unknown>,
): Promise<void> {
  try {
    const response = await fetch(
      "https://api.bilibili.com/x/web-interface/nav",
      { credentials: "include" },
    );
    const data = (await response.json()) as {
      code: number;
      data?: { isLogin?: boolean; uname?: string; mid?: number };
    };

    if (data.code !== 0 || !data.data?.isLogin) {
      return;
    }

    const nextDisplayName =
      data.data.uname?.trim() || (data.data.mid ? `UID-${data.data.mid}` : "");
    if (!nextDisplayName) {
      return;
    }

    const reportResponse = await sendMessage({
      type: "content:report-user",
      payload: { displayName: nextDisplayName },
    });
    if (reportResponse === null) {
      return;
    }
  } catch {
    // Ignore lookup failures and keep guest naming.
  }
}
