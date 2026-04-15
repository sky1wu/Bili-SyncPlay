export async function runtimeSendMessage<T>(
  message: unknown,
): Promise<T | null> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Extension context invalidated")
    ) {
      return null;
    }
    throw error;
  }
}
