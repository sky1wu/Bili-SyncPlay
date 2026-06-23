const EXTENSION_CONTEXT_INVALIDATED_MESSAGE = "Extension context invalidated";

export function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes(EXTENSION_CONTEXT_INVALIDATED_MESSAGE);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}
