import { isExtensionContextInvalidatedError } from "../shared/extension-errors";

export async function runtimeSendMessage<T>(
  message: unknown,
): Promise<T | null> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return null;
    }
    throw error;
  }
}
