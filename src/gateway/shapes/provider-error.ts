/**
 * The provider's own status and message, kept as debug evidence for the host's operators. Never
 * put it in event payloads or model context, and never show the message to an end user.
 */
export type ProviderErrorResponse = {
  /** HTTP status; null when the provider reported the failure inside the stream. */
  status: number | null;
  message: string;
};
