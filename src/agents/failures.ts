export function classifyProviderFailure(text: string): string | undefined {
  const value = text.toLowerCase();
  if (/quota|rate limit|usage limit|resource exhausted/.test(value)) return "QUOTA_EXHAUSTED";
  if (/service unavailable|temporarily unavailable|503|overloaded|backend unavailable/.test(value)) return "SERVICE_UNAVAILABLE";
  if (/model .*not (available|recognized)|invalid model|model access|unknown model|not entitled/.test(value)) return "MODEL_UNAVAILABLE";
  if (/authentication required|not authenticated|login required|unauthorized|401/.test(value)) return "AUTH_REQUIRED";
  if (/permission denied|approval required|blocked by policy/.test(value)) return "PERMISSION_DENIED";
  return undefined;
}
